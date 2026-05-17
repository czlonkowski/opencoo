/**
 * AgentsRunNowButton — "Run now" / "Refresh now" / "Re-run lint"
 * CTA that dispatches an agent on demand via
 * `POST /api/admin/agents/:slug/dispatch` (PR-R3, phase-a appendix
 * #10).
 *
 * State machine (idle → queued → running → done → idle):
 *   idle     — default chrome (Btn variant="advisory"), label
 *              from the `label` prop. Clicking transitions to
 *              `queued`.
 *   queued   — the dispatch POST is in flight. Label flips to
 *              "Queued · {sec}s" with the heartbeat-pulse glyph
 *              (the ONLY allowed motion loop in the entire app —
 *              see CLAUDE.md design system § motion).
 *   running  — the SSE listener observed a `running` lifecycle
 *              event for the runId we tracked.
 *   done     — the SSE listener observed a `success` lifecycle
 *              event; the button shows a brief filled-disc
 *              glyph then reverts to idle after ~1.5s.
 *   429      — the POST returned 429; we render the regular idle
 *              chrome but show a tooltip "Rate limited — try again
 *              in {n}s" using the Retry-After header value.
 *
 * Design constraints (CLAUDE.md):
 *   - The heartbeat-pulse glyph (operate-glyph + animation) is
 *     the ONLY allowed motion loop. No spinners, shimmer, bounces.
 *   - The `--advisory` accent (Advisory Amber) is reserved for
 *     agent-layer CTAs — a "Run now" button is a textbook fit.
 *     Stay UNDER 10% per screen — caller is responsible for
 *     placement.
 *   - NO emoji; the success indicator uses the GlyphFilledDisc
 *     primitive (compiled-state semantics).
 */
import { useEffect, useRef, useState } from "react";

import { ApiValidationError, fetchAdmin, fetchOptsFor } from "../lib/api.js";
import type { SubscribeToAgentRuns } from "../lib/agent-runs-subscription.js";
import { GlyphFilledDisc, GlyphRingWithDot } from "./Glyph.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type ButtonState = "idle" | "queued" | "running" | "done";

export interface AgentsRunNowButtonProps {
  /** Agent slug — heartbeat / lint / surfacer / builder. The
   *  `:slug` URL param the dispatch endpoint expects. */
  readonly agentSlug: "heartbeat" | "lint" | "surfacer" | "builder";
  /** Target domain slug. */
  readonly domainSlug: string;
  /** Optional target instance slug. When omitted, the server
   *  falls back to the first instance scoped to the domain. */
  readonly instanceSlug?: string;
  /** Idle-state button label — "Run now", "Refresh now", or
   *  "Re-run lint" depending on the surface. Caller passes the
   *  i18n-resolved string. */
  readonly idleLabel: string;
  /** "Queued · {sec}s" formatter — caller passes the i18n-
   *  resolved template, the button substitutes `{sec}`. */
  readonly queuedLabelFormat: string;
  /** "Running · {sec}s" formatter — shown after the SSE feed
   *  observes a `running` event, before the run terminalises.
   *  Caller passes the i18n template; the button substitutes
   *  `{sec}`. When omitted, the button keeps the queued label
   *  through the running state. */
  readonly runningLabelFormat?: string;
  /** "Rate limited — try again in {sec}s" tooltip formatter. */
  readonly rateLimitedTooltipFormat: string;
  /** Subscribe to SSE `agent_run` lifecycle events. The button
   *  uses the listener to flip from `queued`/`running` → `done`.
   *
   *  CRITICAL: callers MUST share ONE `AgentRunSubscription` object
   *  across multiple buttons on the same page mount (typically via
   *  `createAgentRunsSubscription` inside a parent `useMemo`) and
   *  pass `subscription.subscribe` here. Constructing a fresh
   *  subscription per button mount opens N concurrent SSE pipes
   *  against the same admin endpoint — see
   *  `lib/agent-runs-subscription.ts` for the wiring contract.
   *
   *  The returned `off` from `subscribe(handler)` only detaches
   *  THIS handler; the underlying SSE client lives until the
   *  parent's unmount effect calls `subscription.close()`. */
  readonly subscribeToAgentRuns: SubscribeToAgentRuns;
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /** @internal Test seam — overrides the per-second tick used to
   *  refresh the "Queued · Ns" countdown label. Defaults to
   *  setInterval. */
  readonly setIntervalFn?: typeof setInterval;
  /** @internal Test seam. */
  readonly clearIntervalFn?: typeof clearInterval;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AgentsRunNowButton(
  props: AgentsRunNowButtonProps,
): JSX.Element {
  const [state, setState] = useState<ButtonState>("idle");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [tickNow, setTickNow] = useState<number>(() => Date.now());
  const [rateLimitedSec, setRateLimitedSec] = useState<number | null>(null);
  const [trackedRunId, setTrackedRunId] = useState<string | null>(null);
  // The dispatch returns a `jobId`, but the SSE feed publishes
  // `runId` events. We don't have a reliable mapping in v0.1, so
  // the button observes the FIRST `agent_run` event whose
  // `definitionSlug` matches `agentSlug` after we kicked the
  // dispatch — sufficient for single-operator use.
  const dispatchedAtRef = useRef<number | null>(null);

  // ── Timer refs (PR-R3 fix-up Issue C) ──
  // Both setTimeout call sites store their handle in a ref so the
  // unmount cleanup can clear them — otherwise a late callback fires
  // setState() on an unmounted component, surfacing as a React
  // warning AND (worse) reviving state on a re-mounted instance with
  // the same identity. Each call site clears its existing ref before
  // scheduling a fresh timer so back-to-back state transitions don't
  // leak overlapping handles.
  const doneFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const setIntervalImpl = props.setIntervalFn ?? setInterval;
  const clearIntervalImpl = props.clearIntervalFn ?? clearInterval;

  // ── Unmount cleanup for the two setTimeout handles ──
  useEffect(
    () => (): void => {
      if (doneFlashRef.current !== null) {
        clearTimeout(doneFlashRef.current);
        doneFlashRef.current = null;
      }
      if (safetyTimeoutRef.current !== null) {
        clearTimeout(safetyTimeoutRef.current);
        safetyTimeoutRef.current = null;
      }
    },
    [],
  );

  // ── countdown tick when the button is in queued/running state ──
  useEffect(() => {
    if (state !== "queued" && state !== "running") return;
    const handle = setIntervalImpl(() => {
      setTickNow(Date.now());
    }, 1000);
    return (): void => {
      clearIntervalImpl(handle);
    };
  }, [state, setIntervalImpl, clearIntervalImpl]);

  // ── SSE-driven status transitions ──
  useEffect(() => {
    const off = props.subscribeToAgentRuns((evt) => {
      // Match by definitionSlug AND only after we kicked a dispatch.
      // No runId mapping yet — first event that matches the
      // expected slug after our dispatch wins. For the operator's
      // single-tab use this is sufficient; v0.2 wires runId
      // through the dispatch response when the harness exposes a
      // pre-startRun hook.
      if (dispatchedAtRef.current === null) return;
      if (evt.definitionSlug !== props.agentSlug) return;
      if (evt.status === "running") {
        setState((prev) =>
          prev === "queued" || prev === "running" ? "running" : prev,
        );
        setTrackedRunId(evt.runId);
        return;
      }
      if (evt.status === "success" || evt.status === "failed" || evt.status === "timeout") {
        setState((prev) =>
          prev === "queued" || prev === "running" ? "done" : prev,
        );
        // After a brief flash, revert to idle so the operator can
        // fire again. 1500ms matches the success-pill semantic
        // in CopyButton (Reports.tsx). The handle is stored in a
        // ref so unmount cleanup can cancel it (Issue C); we also
        // clear any prior handle so back-to-back terminal events
        // don't leak overlapping timers.
        if (doneFlashRef.current !== null) {
          clearTimeout(doneFlashRef.current);
        }
        doneFlashRef.current = setTimeout(() => {
          doneFlashRef.current = null;
          setState("idle");
          setStartedAt(null);
          setTrackedRunId(null);
          dispatchedAtRef.current = null;
        }, 1500);
        return;
      }
    });
    return off;
  }, [props.agentSlug, props.subscribeToAgentRuns]);

  // Avoid linter "unused" on trackedRunId — surfaced via data-attr
  // for tests + future deep-link UX.
  const dataRunId = trackedRunId ?? undefined;

  const handleClick = async (): Promise<void> => {
    if (state !== "idle") return;
    setState("queued");
    const now = Date.now();
    setStartedAt(now);
    setTickNow(now);
    dispatchedAtRef.current = now;
    setRateLimitedSec(null);

    try {
      const body: Record<string, unknown> = {
        domainSlug: props.domainSlug,
      };
      if (props.instanceSlug !== undefined) {
        body["instanceSlug"] = props.instanceSlug;
      }
      await fetchAdmin(`/api/admin/agents/${props.agentSlug}/dispatch`, {
        method: "POST",
        body,
        ...fetchOptsFor(props.fetchImpl),
      });
      // Successful dispatch — stay in `queued` until the SSE
      // listener flips us to `running` / `done`. A safety timeout
      // reverts to `idle` from EITHER `queued` OR `running` so that
      // an SSE drop AFTER the `running` event also self-heals
      // (Issue B — previously the button stayed stuck in `running`
      // forever once it left `queued`). 120s window — Heartbeat's
      // Thinker tier can take 30–60s; 60s was too tight and tripped
      // the safety net during legitimate long runs. The handle is
      // ref-tracked so unmount cleanup can cancel it (Issue C); we
      // clear any prior handle so back-to-back dispatches don't
      // leak overlapping timers.
      if (safetyTimeoutRef.current !== null) {
        clearTimeout(safetyTimeoutRef.current);
      }
      safetyTimeoutRef.current = setTimeout(() => {
        safetyTimeoutRef.current = null;
        setState((prev) =>
          prev === "queued" || prev === "running" ? "idle" : prev,
        );
      }, 120_000);
    } catch (err) {
      // 429 rate-limit → surface tooltip + revert to idle.
      if (
        err instanceof ApiValidationError &&
        err.status === 429
      ) {
        const body = err.body as { retryAfterSec?: number } | undefined;
        const sec = body?.retryAfterSec ?? 60;
        setRateLimitedSec(sec);
      }
      setState("idle");
      setStartedAt(null);
      dispatchedAtRef.current = null;
    }
  };

  // ── Label resolution ──
  const elapsedSec =
    startedAt !== null ? Math.max(0, Math.floor((tickNow - startedAt) / 1000)) : 0;

  const formatTemplate = (template: string, sec: number): string =>
    template.replace("{sec}", String(sec));

  let label: string;
  let showHeartbeat = false;
  let showDoneGlyph = false;
  switch (state) {
    case "queued":
      label = formatTemplate(props.queuedLabelFormat, elapsedSec);
      showHeartbeat = true;
      break;
    case "running":
      label = formatTemplate(
        props.runningLabelFormat ?? props.queuedLabelFormat,
        elapsedSec,
      );
      showHeartbeat = true;
      break;
    case "done":
      label = props.idleLabel;
      showDoneGlyph = true;
      break;
    default:
      // idle
      label = props.idleLabel;
      break;
  }

  const tooltip =
    rateLimitedSec !== null
      ? formatTemplate(props.rateLimitedTooltipFormat, rateLimitedSec)
      : undefined;

  // Style mirrors `Btn` variant="advisory" — agent-layer CTA per
  // the design system. Inline so the heartbeat-glyph + label sit
  // in one button without re-implementing the Btn shape.
  const disabled = state !== "idle";

  return (
    <button
      type="button"
      onClick={(): void => {
        void handleClick();
      }}
      disabled={disabled}
      title={tooltip}
      data-state={state}
      data-run-id={dataRunId}
      data-rate-limited-sec={
        rateLimitedSec !== null ? String(rateLimitedSec) : undefined
      }
      data-agent-slug={props.agentSlug}
      data-domain-slug={props.domainSlug}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        fontWeight: 500,
        padding: "8px 12px",
        borderRadius: 3,
        borderStyle: "solid",
        borderWidth: 1,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.85 : 1,
        background: "var(--advisory)",
        color: "var(--ink)",
        borderColor: "var(--advisory-ink)",
      }}
    >
      {showHeartbeat && (
        // The heartbeat-pulse glyph is the ONLY motion loop allowed
        // in the entire app (CLAUDE.md design system § motion).
        // The `heartbeat-glyph` class wires the
        // `opencoo-heartbeat var(--heartbeat-dur) infinite`
        // animation defined in `styles/app.css`.
        <span
          className="heartbeat-glyph"
          aria-hidden
          data-testid="agents-run-now-heartbeat"
          style={{ display: "inline-flex", color: "var(--ink)" }}
        >
          <GlyphRingWithDot size={14} />
        </span>
      )}
      {showDoneGlyph && (
        <span
          aria-hidden
          data-testid="agents-run-now-done"
          style={{ display: "inline-flex", color: "var(--healthy)" }}
        >
          <GlyphFilledDisc size={14} />
        </span>
      )}
      {label}
    </button>
  );
}
