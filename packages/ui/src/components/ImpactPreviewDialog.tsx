/**
 * ImpactPreviewDialog — `source forget` impact preview + gated
 * confirmation modal (PR-R7, phase-a appendix #10).
 *
 * Opened from the SourceBindingDetail row drill-down's "Forget
 * source" button. The flow:
 *
 *   1. On open, POST `?dryRun=1` to load the impact (recompile /
 *      delete / citations / cap state).
 *   2. Render the impact summary; if pages will delete entirely,
 *      list their wiki paths in mono with `--wiki` (Wiki Teal —
 *      one of the few approved uses; citation paths qualify per
 *      the design-system "Wiki Teal only on compiled-knowledge
 *      chrome" rule).
 *   3. If today's used + planned deletes > cap, show an inline
 *      `--alert` warning and disable the destructive button.
 *      Otherwise show a checkbox-gated confirm: "I understand X
 *      pages will recompile and Y will delete permanently". Until
 *      ticked, the destructive button is disabled.
 *   4. On confirm, POST `?dryRun=0` and close on 200 (parent
 *      refetches via `onConfirmed`).
 *
 * Hard-nos honored (CLAUDE.md design system):
 *   - NO drop shadows, NO backdrop-blur, NO emoji, NO gradients.
 *   - `--alert` ONLY on the destructive Confirm button + cap-
 *     exceeded inline warning.
 *   - `--wiki` ONLY on the wiki-path badges in the deleted-paths
 *     list. NOT used for the recompile list (those are not
 *     citations being followed; they're paths *being affected* —
 *     borderline, but the rule restricts `--wiki` to citations
 *     and we keep it tight here).
 *   - `JetBrains Mono` for paths and counts.
 *   - Modal radius cap (the shared Modal already enforces this).
 *   - NO motion loops; the loading state is a flat label, no
 *     spinner.
 *
 * THREAT-MODEL alignment:
 *   - The destructive button is checkbox-gated CLIENT-side; the
 *     server still enforces the CSRF + cap invariants regardless
 *     (the UI is convenience, not the security perimeter).
 *   - Cap-exceeded is detected in BOTH the dry-run response AND
 *     the actual-forget 409; the UI surfaces the same warning in
 *     both paths so the operator sees it immediately on open and
 *     again if a concurrent forget eats the budget mid-confirm.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Modal } from "./Modal.js";
import {
  ApiAuthError,
  ApiTransientError,
  ApiValidationError,
  fetchAdmin,
  fetchOptsFor,
} from "../lib/api.js";

export interface ImpactPreviewDialogProps {
  readonly bindingId: string;
  /** Closed when the operator dismisses (Esc / backdrop / Cancel). */
  readonly onClose: () => void;
  /** Fired AFTER the actual-forget POST `?dryRun=0` returns 200.
   *  The Sources route bumps its refresh nonce so the row list
   *  re-pulls (and the binding's status flips). */
  readonly onConfirmed: () => void;
  /** @internal Test seam — defaults to globalThis.fetch via fetchAdmin. */
  readonly fetchImpl?: typeof fetch;
}

interface DryRunResponse {
  readonly pagesRecompiled: readonly string[];
  readonly pagesDeleted: readonly string[];
  readonly citationsRemoved: number;
  readonly dailyDeleteCapState: { readonly used: number; readonly cap: number };
}

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const BODY_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
  lineHeight: "var(--lh-body)",
  color: "var(--fg-2)",
  margin: 0,
};

const IMPACT_SUMMARY_STYLE: CSSProperties = {
  ...BODY_STYLE,
  color: "var(--fg-1)",
};

const COUNT_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
};

const PATHS_LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  margin: 0,
  padding: "var(--space-3) var(--space-4)",
  background: "var(--paper-2)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  listStyle: "none",
};

/** Wiki-path badge — ONLY approved use of `--wiki` here.
 *  Compiled-knowledge chrome rule (design-system): citations + path
 *  badges qualify; this is the deleted-paths list of pages whose
 *  ONLY citation source is the binding being forgotten. */
const WIKI_PATH_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
  color: "var(--wiki-ink)",
  wordBreak: "break-all",
};

const CAP_INFO_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  color: "var(--ink-3)",
  margin: 0,
};

const CAP_ALERT_STYLE: CSSProperties = {
  ...CAP_INFO_STYLE,
  color: "var(--alert)",
};

const CHECKBOX_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--space-3)",
  padding: "var(--space-3) 0",
};

const CHECKBOX_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  lineHeight: "var(--lh-small)",
  color: "var(--fg-2)",
};

const ERROR_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--alert)",
  margin: 0,
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-3)",
};

/** Destructive Confirm button — `--alert` border + fill (admin
 *  chrome). Mirrors the SourceBindingDetail Delete button but with
 *  the Confirm semantics specific to forget.
 *
 *  Border is split into individual longhand properties so the
 *  enabled→disabled transition can swap `borderColor` without
 *  React warning about shorthand/longhand conflicts (the render-
 *  swap path otherwise drops borderColor while a `border` shorthand
 *  is also set, which jsdom + React both flag). */
const DESTRUCTIVE_BTN_STYLE: CSSProperties = {
  background: "var(--alert)",
  color: "var(--paper)",
  borderStyle: "solid",
  borderWidth: 1,
  borderColor: "var(--alert)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-body)",
  cursor: "pointer",
};

const DESTRUCTIVE_BTN_DISABLED_STYLE: CSSProperties = {
  ...DESTRUCTIVE_BTN_STYLE,
  background: "var(--ink-3)",
  borderColor: "var(--ink-3)",
  cursor: "not-allowed",
};

export function ImpactPreviewDialog(
  props: ImpactPreviewDialogProps,
): JSX.Element {
  const { t } = useTranslation();
  const [impact, setImpact] = useState<DryRunResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  // Load the dry-run impact on mount. Re-runs only if the binding id
  // changes (which doesn't happen in practice — the modal mounts
  // fresh per binding click), but the dep guards against a parent
  // pattern that mounts a single dialog and swaps `bindingId`.
  useEffect(() => {
    let cancelled = false;
    setImpact(null);
    setLoadError(null);
    void (async () => {
      try {
        const resp = await fetchAdmin<DryRunResponse>(
          `/api/admin/source-bindings/${props.bindingId}/forget?dryRun=1`,
          {
            method: "POST",
            ...fetchOptsFor(props.fetchImpl),
          },
        );
        if (cancelled || !mountedRef.current) return;
        setImpact(resp);
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        if (err instanceof ApiAuthError) {
          setLoadError(t("forgetImpact.errors.auth"));
        } else if (err instanceof ApiTransientError) {
          setLoadError(t("forgetImpact.errors.transient"));
        } else {
          setLoadError(t("forgetImpact.errors.loadFailed"));
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [props.bindingId, props.fetchImpl, t]);

  const capExceeded =
    impact !== null &&
    impact.dailyDeleteCapState.used + impact.pagesDeleted.length >
      impact.dailyDeleteCapState.cap;
  const confirmDisabled =
    impact === null || capExceeded || !acknowledged || confirming;

  const submitConfirm = async (): Promise<void> => {
    if (impact === null || capExceeded || !acknowledged) return;
    setConfirmError(null);
    setConfirming(true);
    try {
      await fetchAdmin<DryRunResponse>(
        `/api/admin/source-bindings/${props.bindingId}/forget?dryRun=0`,
        {
          method: "POST",
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      if (!mountedRef.current) return;
      props.onConfirmed();
      props.onClose();
    } catch (err) {
      if (!mountedRef.current) return;
      // 409 daily_cap_exceeded — re-render the cap state with the
      // server's authoritative numbers (a concurrent forget may
      // have eaten the budget between the dry-run and confirm).
      if (
        err instanceof ApiValidationError &&
        err.status === 409 &&
        (err.body as { error?: string } | undefined)?.error ===
          "daily_cap_exceeded"
      ) {
        const body = err.body as
          | { dailyDeleteCapState?: { used: number; cap: number } }
          | undefined;
        const refreshedCap = body?.dailyDeleteCapState;
        if (refreshedCap !== undefined) {
          setImpact((prev) =>
            prev === null
              ? prev
              : { ...prev, dailyDeleteCapState: refreshedCap },
          );
        }
        setConfirmError(t("forgetImpact.errors.capExceeded"));
        return;
      }
      if (err instanceof ApiAuthError) {
        setConfirmError(t("forgetImpact.errors.auth"));
        return;
      }
      if (err instanceof ApiTransientError) {
        setConfirmError(t("forgetImpact.errors.transient"));
        return;
      }
      setConfirmError(t("forgetImpact.errors.confirmFailed"));
    } finally {
      if (mountedRef.current) setConfirming(false);
    }
  };

  return (
    <Modal
      title={t("forgetImpact.title")}
      onClose={props.onClose}
      maxWidth={620}
      actions={
        <div style={FOOTER_STYLE}>
          <Btn
            variant="ghost"
            onClick={props.onClose}
            disabled={confirming}
          >
            {t("forgetImpact.cancel")}
          </Btn>
          <button
            type="button"
            data-testid="forget-impact-confirm"
            disabled={confirmDisabled}
            onClick={(): void => {
              void submitConfirm();
            }}
            style={
              confirmDisabled
                ? DESTRUCTIVE_BTN_DISABLED_STYLE
                : DESTRUCTIVE_BTN_STYLE
            }
          >
            {confirming
              ? t("forgetImpact.confirming")
              : t("forgetImpact.confirm")}
          </button>
        </div>
      }
    >
      <div style={SECTION_STYLE}>
        <p style={BODY_STYLE}>{t("forgetImpact.lead")}</p>

        {loadError !== null && (
          <p style={ERROR_TEXT_STYLE} role="alert">
            {loadError}
          </p>
        )}
        {loadError === null && impact === null && (
          <p
            style={BODY_STYLE}
            role="status"
            data-testid="forget-impact-loading"
          >
            {t("forgetImpact.loading")}
          </p>
        )}
        {loadError === null && impact !== null && (
          <>
            <p style={IMPACT_SUMMARY_STYLE} data-testid="forget-impact-summary">
              {t("forgetImpact.summary", {
                recompile: impact.pagesRecompiled.length,
                deletes: impact.pagesDeleted.length,
                citations: impact.citationsRemoved,
              })}
            </p>

            {impact.pagesDeleted.length > 0 && (
              <ul
                style={PATHS_LIST_STYLE}
                data-testid="forget-impact-deleted-paths"
              >
                {impact.pagesDeleted.map((p) => (
                  <li key={p} style={WIKI_PATH_STYLE}>
                    {p}
                  </li>
                ))}
              </ul>
            )}

            {capExceeded ? (
              <p style={CAP_ALERT_STYLE} role="alert" data-testid="cap-alert">
                {t("forgetImpact.capExceeded", {
                  cap: impact.dailyDeleteCapState.cap,
                })}
              </p>
            ) : (
              <p style={CAP_INFO_STYLE} data-testid="cap-info">
                <span style={COUNT_STYLE}>
                  {t("forgetImpact.capUsed", {
                    used: impact.dailyDeleteCapState.used,
                    cap: impact.dailyDeleteCapState.cap,
                  })}
                </span>
              </p>
            )}

            {!capExceeded && (
              <label style={CHECKBOX_ROW_STYLE}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e): void => setAcknowledged(e.target.checked)}
                  disabled={confirming}
                  data-testid="forget-impact-checkbox"
                />
                <span style={CHECKBOX_LABEL_STYLE}>
                  {t("forgetImpact.acknowledge", {
                    recompile: impact.pagesRecompiled.length,
                    deletes: impact.pagesDeleted.length,
                  })}
                </span>
              </label>
            )}
          </>
        )}

        {confirmError !== null && (
          <p style={ERROR_TEXT_STYLE} role="alert">
            {confirmError}
          </p>
        )}
      </div>
    </Modal>
  );
}
