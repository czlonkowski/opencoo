/**
 * Review Dashboard — lint findings sub-view.
 *
 * Consumes `GET /api/admin/lint-findings` (existing endpoint).
 * Acknowledges individual findings via a POST to the audit endpoint
 * using the `lint_finding.acknowledge` audit verb (already in the
 * server-side allowlist per PR #28).
 *
 * The acknowledge endpoint shape is:
 *   POST /api/admin/lint-findings/:runId/acknowledge
 *   Body: { findingId: string; note?: string }
 *   where findingId = `${kind}:${path}`
 *
 * Security: all state-changing actions go through existing audited
 * endpoints. CSRF token is injected by fetchAdmin automatically.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AgentsRunNowButton } from "../../components/AgentsRunNowButton.js";
import { Btn } from "../../components/Btn.js";
import { NoticeRow } from "../../components/NoticeRow.js";
import {
  createAgentRunsSubscription,
  type SubscribeToAgentRuns,
} from "../../lib/agent-runs-subscription.js";
import { fetchAdmin, fetchOptsFor } from "../../lib/api.js";
import { extractDomainSlugFromPath } from "../../lib/wiki-path.js";
import { ReviewTableHeader } from "./ReviewTableHeader.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface LintFinding {
  readonly kind: string;
  readonly path: string;
  readonly detail: string;
}

interface LintRun {
  readonly runId: string;
  readonly instanceId: string | null;
  readonly endedAt: string | null;
  readonly findings: readonly LintFinding[];
}

interface LintFindingsResponse {
  readonly runs: readonly LintRun[];
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface LintFindingsProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /** @internal Test seam — per-listener subscribe callable for
   *  the "Re-run lint" button. When omitted, the route builds
   *  ONE shared subscription via `createAgentRunsSubscription`
   *  per mount and hands its `subscribe` down. Tests inject a
   *  stub directly so the button's lifecycle observation is
   *  deterministic. */
  readonly subscribeToAgentRuns?: SubscribeToAgentRuns;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function LintFindings(props: LintFindingsProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<readonly LintRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [ackErrors, setAckErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetchAdmin<LintFindingsResponse>(
          "/api/admin/lint-findings",
          fetchOptsFor(props.fetchImpl),
        );
        setRuns(r.runs);
      } catch {
        setError(t("common.error"));
      }
    })();
  }, []);

  // Build a stable SSE subscription for the "Re-run lint"
  // button. ONE underlying client per LintFindings mount; the
  // button calls `subscription.subscribe(listener)` to add a
  // handler without re-opening the SSE pipe. Tests inject a stub
  // `subscribe` callable directly via the prop and skip the
  // subscription object.
  const injectedSubscribe = props.subscribeToAgentRuns;
  const subscription = useMemo(
    () =>
      injectedSubscribe !== undefined
        ? null
        : createAgentRunsSubscription(),
    [injectedSubscribe],
  );
  useEffect(
    () => (): void => {
      subscription?.close();
    },
    [subscription],
  );
  const subscribeToAgentRuns: SubscribeToAgentRuns =
    injectedSubscribe ?? subscription!.subscribe;

  if (error !== null) return <NoticeRow tone="alert">{error}</NoticeRow>;
  if (runs === null) return <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>;

  const allFindings = runs.flatMap((run) =>
    run.findings.map((f) => ({ ...f, runId: run.runId, endedAt: run.endedAt })),
  );

  // Resolve the dispatch domain from the first finding's path.
  // Lint findings live under a single domain per run; the path
  // prefix IS the domain slug (e.g. `wiki-exec/ops/planning.md`).
  // When no findings exist OR the path doesn't yield a slug, the
  // "Re-run lint" button is suppressed (no safe domain to target).
  const dispatchDomain =
    allFindings.length > 0
      ? extractDomainSlugFromPath(allFindings[0]!.path)
      : null;

  if (allFindings.length === 0) {
    return <NoticeRow tone="muted">{t("review.lintFindings.empty")}</NoticeRow>;
  }

  const ackKey = (runId: string, kind: string, path: string): string =>
    `${runId}:${kind}:${path}`;

  const handleAck = async (runId: string, kind: string, path: string): Promise<void> => {
    const key = ackKey(runId, kind, path);
    try {
      await fetchAdmin(
        `/api/admin/lint-findings/${runId}/acknowledge`,
        {
          method: "POST",
          body: { findingId: `${kind}:${path}` },
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      setAcknowledged((prev) => new Set([...prev, key]));
    } catch {
      setAckErrors((prev) => ({ ...prev, [key]: t("common.error") }));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {/* PR-R3 — "Re-run lint" CTA at the top of the findings list.
          Dispatched against the domain extracted from the first
          finding's path. Suppressed when no safe domain can be
          inferred. */}
      {dispatchDomain !== null && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            padding: "8px 0 12px",
            borderBottom: "1px solid var(--rule)",
          }}
        >
          <AgentsRunNowButton
            agentSlug="lint"
            domainSlug={dispatchDomain}
            idleLabel={t("agentsRunNow.labels.rerunLint")}
            queuedLabelFormat={t("agentsRunNow.labels.queued")}
            runningLabelFormat={t("agentsRunNow.labels.running")}
            rateLimitedTooltipFormat={t("agentsRunNow.tooltips.rateLimited")}
            subscribeToAgentRuns={subscribeToAgentRuns}
            {...(props.fetchImpl !== undefined ? { fetchImpl: props.fetchImpl } : {})}
          />
        </div>
      )}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontFamily: "var(--font-sans)",
          fontSize: 13,
        }}
      >
        <ReviewTableHeader
          columns={[
            t("review.lintFindings.columns.kind"),
            t("review.lintFindings.columns.path"),
            t("review.lintFindings.columns.detail"),
            t("review.lintFindings.columns.actions"),
          ]}
        />
        <tbody>
          {allFindings.map((f) => {
            const key = ackKey(f.runId, f.kind, f.path);
            const isAcked = acknowledged.has(key);
            return (
              <tr
                key={key}
                style={{
                  borderBottom: "1px solid var(--rule)",
                  opacity: isAcked ? 0.4 : 1,
                }}
              >
                <td
                  style={{
                    padding: "10px 8px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--advisory-ink)",
                  }}
                >
                  {f.kind}
                </td>
                <td
                  style={{
                    padding: "10px 8px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--wiki)",
                  }}
                >
                  {f.path}
                </td>
                <td
                  style={{
                    padding: "10px 8px",
                    color: "var(--ink-2)",
                    maxWidth: 380,
                  }}
                >
                  {f.detail}
                </td>
                <td style={{ padding: "10px 8px" }}>
                  {!isAcked && (
                    <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <Btn
                        variant="ghost"
                        onClick={(): void => {
                          void handleAck(f.runId, f.kind, f.path);
                        }}
                      >
                        {t("review.lintFindings.acknowledge")}
                      </Btn>
                      {ackErrors[key] !== undefined && (
                        <span style={{ fontSize: 11, color: "var(--alert)" }}>
                          {ackErrors[key]}
                        </span>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
