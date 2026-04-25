/**
 * PAT entry modal — first-paint surface when no PAT is in
 * sessionStorage. Document-level explanation of the storage
 * trade-off (decision Q3).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Field } from "./Field.js";

export interface PatEntryModalProps {
  readonly onSubmit: (pat: string) => Promise<void> | void;
  readonly error?: string | null;
}

export function PatEntryModal(props: PatEntryModalProps): JSX.Element {
  const { t } = useTranslation();
  const [pat, setPat] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  const error = localError ?? props.error ?? undefined;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in oklab, var(--paper) 70%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      role="dialog"
      aria-labelledby="pat-modal-title"
    >
      <div
        style={{
          width: "100%",
          maxWidth: 480,
          background: "var(--paper)",
          border: "1px solid var(--rule)",
          borderRadius: "var(--radius-xl)",
          padding: 28,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div>
          <div
            id="pat-modal-title"
            style={{
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              fontSize: "var(--fs-h3)",
              color: "var(--ink)",
            }}
          >
            {t("app.title")}
          </div>
          <div
            style={{
              marginTop: 4,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)",
              color: "var(--ink-3)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {t("auth.patPrompt")}
          </div>
        </div>
        <Field
          label="pat"
          name="pat"
          value={pat}
          onChange={(e): void => setPat(e.target.value)}
          required
          secret
          helper={t("auth.patHelper")}
          {...(error !== undefined ? { error } : {})}
        />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn
            variant="primary"
            onClick={(): void => {
              void submit();
            }}
            disabled={submitting}
          >
            {t("auth.patSubmit")}
          </Btn>
        </div>
      </div>
    </div>
  );
}
