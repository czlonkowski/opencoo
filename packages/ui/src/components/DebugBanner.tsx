/**
 * `LLM_DEBUG_LOG=1` banner (PR 29 / plan #131, decision Q12).
 *
 * Top-of-Chrome, advisory-amber strip, full-width, persistent
 * (NOT dismissible). Surfaced when any admin-API JSON response
 * carries `_llmDebugLogActive: true` (the onSend hook wired in
 * PR 28).
 *
 * The banner counts toward the advisory-budget on this surface
 * (under 10% per screen rule) — but it's the canonical
 * advisory channel: an operator looking at a debug-mode engine
 * deserves a permanent reminder.
 */
import { useTranslation } from "react-i18next";

export interface DebugBannerProps {
  readonly visible: boolean;
}

export function DebugBanner(props: DebugBannerProps): JSX.Element | null {
  const { t } = useTranslation();
  if (!props.visible) return null;
  return (
    <div
      role="status"
      style={{
        background: "color-mix(in oklab, var(--advisory) 35%, var(--paper))",
        color: "var(--advisory-ink)",
        borderBottom: "1px solid",
        borderBottomColor: "color-mix(in oklab, var(--advisory) 50%, var(--paper))",
        padding: "8px 24px",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-micro)",
        letterSpacing: "0.06em",
        textAlign: "center",
      }}
    >
      {t("debug.bannerLabel")}
    </div>
  );
}
