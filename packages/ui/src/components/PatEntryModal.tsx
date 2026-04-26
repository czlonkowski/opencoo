/**
 * PatEntryModal — first-load admin auth modal (PR 29 / plan
 * #131; UX token-binding spec).
 *
 * Operator pastes a Gitea PAT into a single password-masked
 * field; PAT lives in sessionStorage and clears on tab close.
 * Admin-only chrome (no agent layer involved): primary button
 * is ink-on-paper, NOT advisory amber.
 *
 * Design-system bindings (every visual references a CSS var
 * from `colors_and_type.css`; no literals):
 *   - overlay-backdrop: rgba(18,18,16,0.32) flat (no blur)
 *   - modal-bg: var(--paper); border: 1px solid var(--ink);
 *     radius: var(--radius-xl); padding: var(--space-6)
 *   - title: var(--font-sans), 500, var(--fs-h3)
 *   - input: var(--font-mono) — PAT is an ID
 *   - primary-btn: bg var(--ink), fg var(--paper)
 *
 * Hard-nos honored:
 *   - NO advisory amber on the primary CTA (admin auth, not
 *     agent layer).
 *   - NO eye-icon "show password" toggle (PAT is sensitive).
 *   - NO close icon (modal is gating; auth or nothing).
 *   - NO spinner on submit — disable + label-swap to
 *     `authenticating…` in mono.
 *   - NO drop shadow (border + paper-on-overlay is the
 *     elevation).
 *   - NO emoji, NO Lucide icons, NO marketing voice.
 */
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  // Flat ink-tinted overlay — explicitly no backdrop-blur.
  background: "rgba(18, 18, 16, 0.32)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--space-5)",
};

const MODAL_STYLE: CSSProperties = {
  width: "100%",
  maxWidth: 420,
  background: "var(--paper)",
  border: "1px solid var(--ink)",
  borderRadius: "var(--radius-xl)",
  padding: "var(--space-6)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-h3)",
  lineHeight: "var(--lh-h3)",
  letterSpacing: "var(--tr-h3)",
  color: "var(--fg-1)",
  margin: 0,
};

const INSTRUCTION_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontWeight: 400,
  fontSize: "var(--fs-body)",
  lineHeight: "var(--lh-body)",
  color: "var(--fg-2)",
  margin: 0,
};

const FIELD_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const INPUT_BASE_STYLE: CSSProperties = {
  background: "var(--paper)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-4)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
  color: "var(--fg-1)",
};

const STORAGE_NOTE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  color: "var(--fg-3)",
  margin: 0,
};

const ERROR_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  lineHeight: "var(--lh-small)",
  color: "var(--alert)",
  margin: 0,
};

const PRIMARY_BTN_BASE_STYLE: CSSProperties = {
  background: "var(--ink)",
  color: "var(--paper)",
  border: "1px solid var(--ink)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-body)",
  cursor: "pointer",
  width: "100%",
};

export interface PatEntryModalProps {
  readonly onSubmit: (pat: string) => Promise<void> | void;
  readonly error?: string | null;
}

export function PatEntryModal(props: PatEntryModalProps): JSX.Element {
  const { t } = useTranslation();
  const [pat, setPat] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState(false);

  const submit = async (): Promise<void> => {
    if (pat.length === 0) {
      setLocalError(t("auth.patEmpty"));
      return;
    }
    setLocalError(null);
    setSubmitting(true);
    try {
      await props.onSubmit(pat);
    } finally {
      setSubmitting(false);
    }
  };

  const error = localError ?? props.error ?? null;

  const inputStyle: CSSProperties = {
    ...INPUT_BASE_STYLE,
    ...(focused ? { borderColor: "var(--ink)" } : {}),
    ...(error !== null ? { borderColor: "var(--alert)" } : {}),
  };

  const btnStyle: CSSProperties = {
    ...PRIMARY_BTN_BASE_STYLE,
    ...(submitting
      ? {
          background: "var(--ink-3)",
          borderColor: "var(--ink-3)",
          cursor: "not-allowed",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-mono)",
          fontWeight: 600,
        }
      : {}),
  };

  return (
    <div
      style={BACKDROP_STYLE}
      role="dialog"
      aria-labelledby="pat-modal-title"
      aria-modal="true"
    >
      <div className="opencoo-dialog-enter" style={MODAL_STYLE}>
        <h2 id="pat-modal-title" style={TITLE_STYLE}>
          {t("auth.modalTitle")}
        </h2>
        <p style={INSTRUCTION_STYLE}>{t("auth.patPrompt")}</p>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}
        >
          <label htmlFor="pat-input" style={FIELD_LABEL_STYLE}>
            {t("auth.patFieldLabel")}
          </label>
          <input
            id="pat-input"
            name="pat"
            type="password"
            autoComplete="new-password"
            value={pat}
            onChange={(e): void => setPat(e.target.value)}
            onFocus={(): void => setFocused(true)}
            onBlur={(): void => setFocused(false)}
            style={inputStyle}
            data-secret="true"
            // Spec: secret-field placeholder must NEVER look
            // like a real value. Empty placeholder is the safe
            // choice here.
            placeholder=""
          />
          <p style={STORAGE_NOTE_STYLE}>{t("auth.storageNote")}</p>
          {error !== null ? <p style={ERROR_TEXT_STYLE}>{error}</p> : null}
        </div>
        <button
          type="button"
          disabled={submitting}
          onClick={(): void => {
            void submit();
          }}
          style={btnStyle}
        >
          {submitting ? t("auth.authenticating") : t("auth.patSubmit")}
        </button>
      </div>
    </div>
  );
}
