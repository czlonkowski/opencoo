/**
 * PatEntryModal — first-load admin auth modal (PR 29 / plan
 * #131; UX token-binding spec; collapsed onto the shared `Modal`
 * shell in PR-A1 / phase-a appendix #16; PAT input collapsed
 * onto the shared `Field` primitive in PR-A3 / wave-16 so the
 * SR-only aria-described/errormessage chain is inherited by a
 * keyboard-only operator on a screen reader).
 *
 * Operator pastes a Gitea PAT into a single password-masked
 * field; PAT lives in sessionStorage and clears on tab close.
 * Admin-only chrome (no agent layer involved): primary button
 * is ink-on-paper, NOT advisory amber.
 *
 * Wave-16 (PR-A1) note: this modal is *gating* — operator cannot
 * dismiss it, and `onClose` is intentionally a no-op. We still
 * compose on the shared `<dialog>`-backed Modal so we inherit
 * focus-trap + top-layer + reduced-motion + Firefox
 * font-inherit fix for free. The Modal's backdrop-click + Esc
 * handlers route into the no-op `onClose` (auth or nothing).
 *
 * Wave-16 (PR-A3) note: the PAT input now goes through `Field`
 * with `secret` + `mono`. Field gives us the
 * `aria-describedby`/`aria-errormessage`/`aria-invalid` chain
 * and `role="alert"` on the error span for free; the
 * storage-note rides the `helper` slot, the auth error rides
 * the `error` slot. We lose the (cosmetic) focused-state
 * border, which the design system never spec'd anyway — the
 * border + paper-on-overlay is the elevation contract.
 *
 * Design-system bindings (every visual references a CSS var
 * from `colors_and_type.css`; no literals):
 *   - modal shell: inherited from `Modal.tsx` (paper / ink /
 *     radius-xl). Padding handled by the shell's regions.
 *   - input: inherited from `Field` (secret + mono → password
 *     input rendered in JetBrains Mono per
 *     `design_system/colors_and_type.css`).
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
import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Field } from "./Field.js";
import { LocaleSwitcher } from "./LocaleSwitcher.js";
import { Modal } from "./Modal.js";

const INSTRUCTION_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontWeight: 400,
  fontSize: "var(--fs-body)",
  lineHeight: "var(--lh-body)",
  color: "var(--fg-2)",
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

// PR-W18 — Gitea handoff styles. The explanation is sans-body
// (operator-facing prose); the optional clickable link is a ghost
// CTA (border + paper-2 bg + ink fg) opened in a new tab. No
// shadow, no pills, no emoji — design-system hard-nos respected.
const GITEA_BLOCK_STYLE: CSSProperties = {
  marginTop: "var(--space-4)",
  paddingTop: "var(--space-3)",
  borderTop: "1px solid var(--rule)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const GITEA_HOW_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  lineHeight: "var(--lh-body)",
  color: "var(--fg-3)",
  margin: 0,
  paddingLeft: "var(--space-4)",
};

const GITEA_LINK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignSelf: "flex-start",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  background: "var(--paper-2)",
  color: "var(--ink)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-small)",
  textDecoration: "none",
};

// PR-W18 — locale switcher slot inside the modal header area.
// Mirrors the TopBar's right-aligned chrome placement.
const LOCALE_SLOT_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  marginBottom: "var(--space-2)",
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
  const [giteaUrl, setGiteaUrl] = useState<string | null>(null);

  // PR-W18 — fetch the public config once on mount so we know
  // whether to render the "Open Gitea" clickable link. Silent on
  // failure (no toast region rendered pre-auth); the explanation
  // paragraph stays even when the link is absent.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/public/config", { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { giteaUrl?: string | null } | null) => {
        if (
          data &&
          typeof data.giteaUrl === "string" &&
          data.giteaUrl.length > 0
        ) {
          setGiteaUrl(data.giteaUrl);
        }
      })
      .catch(() => {
        // AbortError or network failure — leave giteaUrl null.
      });
    return (): void => ctrl.abort();
  }, []);

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
    <Modal
      title={t("auth.modalTitle")}
      // Gating modal — there's no Cancel / X. Esc and backdrop
      // both route here so the operator's only path out is
      // successful auth.
      onClose={(): void => undefined}
      maxWidth={420}
    >
      {/* PR-W18 — locale switcher rendered without `onChange` since
          there is no user row to PATCH pre-auth. The flip persists
          via localStorage and reconcileLocaleAtLogin carries the
          choice into the authenticated session. */}
      <div style={LOCALE_SLOT_STYLE}>
        <LocaleSwitcher />
      </div>
      <p style={INSTRUCTION_STYLE}>{t("auth.patPrompt")}</p>
      <Field
        name="pat"
        label={t("auth.patFieldLabel")}
        value={pat}
        onChange={(e): void => setPat(e.target.value)}
        secret
        mono
        // Spec: secret-field placeholder must NEVER look like a
        // real value. Empty placeholder is the safe choice here.
        placeholder=""
        helper={t("auth.storageNote")}
        {...(error !== null ? { error } : {})}
      />
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
      {/* PR-W18 — Gitea handoff. The 3-step explanation always
          renders; the "Open Gitea" link renders only when the engine
          publishes a non-null `giteaUrl` on /api/public/config (env
          GITEA_PUBLIC_URL). Gitea is the human-review surface for
          compiled wikis (architecture §10), so production deployments
          must expose it reachably; this block helps the operator
          find a PAT on first load. */}
      <div style={GITEA_BLOCK_STYLE}>
        <p style={INSTRUCTION_STYLE}>{t("auth.gitea.intro")}</p>
        <ol style={GITEA_HOW_STYLE}>
          <li>{t("auth.gitea.howToGenerate.step1")}</li>
          <li>{t("auth.gitea.howToGenerate.step2")}</li>
          <li>{t("auth.gitea.howToGenerate.step3")}</li>
        </ol>
        {giteaUrl !== null && (
          <a
            href={giteaUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={GITEA_LINK_STYLE}
            data-testid="pat-entry-gitea-link"
          >
            {t("auth.gitea.linkLabel")}
          </a>
        )}
      </div>
    </Modal>
  );
}
