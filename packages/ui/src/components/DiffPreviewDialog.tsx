/**
 * DiffPreviewDialog — sovereignty-diff confirm flow (PR 29 /
 * plan #131, decisions Q4 + Q5).
 *
 * The server is canonical for the diff (PR 28 sovereignty-token
 * primitives). The UI:
 *   1. Receives a `SovereigntyDiffPreview` from the parent
 *      (already fetched from `/api/admin/domains/:id/llm-policy/preview`).
 *   2. Displays the diff side-by-side with a 5-min countdown.
 *   3. On Apply, calls the parent-supplied callback which POSTs
 *      to `/apply` with `{token, proposed}`.
 *   4. On expiry, surfaces an explanation prompting re-preview.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SovereigntyDiffPreview } from "../types.js";

import { Btn } from "./Btn.js";

export interface DiffPreviewDialogProps {
  readonly preview: SovereigntyDiffPreview;
  readonly onApply: () => Promise<void>;
  readonly onCancel: () => void;
  readonly errorMessage?: string | null;
  /** @internal Test seam — defaults to `Date.now()`. */
  readonly now?: () => number;
}

export function DiffPreviewDialog(
  props: DiffPreviewDialogProps,
): JSX.Element {
  const { t } = useTranslation();
  const now = props.now ?? ((): number => Date.now());
  const [secondsLeft, setSecondsLeft] = useState(
    () => Math.max(0, Math.floor((props.preview.expiresAt - now()) / 1000)),
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const tick = (): void => {
      const remaining = Math.max(
        0,
        Math.floor((props.preview.expiresAt - now()) / 1000),
      );
      setSecondsLeft(remaining);
    };
    const id = window.setInterval(tick, 1000);
    return (): void => window.clearInterval(id);
  }, [now, props.preview.expiresAt]);

  const expired = secondsLeft === 0;

  const onApplyClick = async (): Promise<void> => {
    if (expired) return;
    setSubmitting(true);
    try {
      await props.onApply();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-labelledby="diff-dialog-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in oklab, var(--paper) 70%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 720,
          background: "var(--paper)",
          border: "1px solid",
          borderColor: "color-mix(in oklab, var(--wiki) 25%, var(--paper))",
          borderRadius: "var(--radius-xl)",
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div>
          <div
            id="diff-dialog-title"
            style={{
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              fontSize: "var(--fs-h3)",
              color: "var(--ink)",
            }}
          >
            {t("llmPolicy.diffTitle")}
          </div>
          <div
            data-testid="diff-countdown"
            style={{
              marginTop: 4,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)",
              color: expired ? "var(--alert)" : "var(--wiki)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {expired
              ? t("llmPolicy.diffExpired")
              : t("llmPolicy.diffHelp", { seconds: secondsLeft })}
          </div>
        </div>
        <div
          data-testid="diff-list"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            maxHeight: 360,
            overflow: "auto",
            border: "1px solid var(--rule)",
            borderRadius: "var(--radius-m)",
            padding: 12,
            background: "var(--paper-2)",
          }}
        >
          {props.preview.diff.length === 0 ? (
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-micro)",
                color: "var(--ink-3)",
              }}
            >
              {t("llmPolicy.noChanges")}
            </div>
          ) : (
            props.preview.diff.map((entry, idx) => (
              <div
                key={`${entry.path}-${idx}`}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-mono)",
                  color: "var(--ink-2)",
                  display: "grid",
                  gridTemplateColumns: "180px 1fr",
                  gap: 12,
                  paddingBottom: 8,
                  borderBottom: "1px solid var(--rule)",
                }}
              >
                <div style={{ color: "var(--ink-3)" }}>{entry.path}</div>
                <div>
                  <div style={{ color: "var(--alert)" }}>
                    − {JSON.stringify(entry.before)}
                  </div>
                  <div style={{ color: "var(--healthy)" }}>
                    + {JSON.stringify(entry.after)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
        {props.errorMessage !== null && props.errorMessage !== undefined ? (
          <div
            data-testid="diff-error"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)",
              color: "var(--alert)",
              letterSpacing: "0.04em",
            }}
          >
            {props.errorMessage}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <Btn variant="ghost" onClick={props.onCancel}>
            {t("llmPolicy.cancel")}
          </Btn>
          <Btn
            variant="primary"
            disabled={expired || submitting || props.preview.diff.length === 0}
            onClick={(): void => {
              void onApplyClick();
            }}
          >
            {t("llmPolicy.apply")}
          </Btn>
        </div>
      </div>
    </div>
  );
}
