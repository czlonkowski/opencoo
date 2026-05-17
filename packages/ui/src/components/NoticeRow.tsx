/**
 * NoticeRow — single-line muted/alert message used by list views to
 * render their loading, empty, and error states.
 *
 * Tone:
 *   - "muted"  → ink-3 (loading + empty)
 *   - "alert"  → alert (fetch failed)
 *
 * Used by Activity (Runs/Pipelines) and the Review Dashboard sub-views.
 *
 * PR-A4 (wave-16) — `tone="alert"` carries `role="alert"` so the
 * fetch-failure rows the routes display also narrate via the global
 * aria-live wiring. Muted rows are left without a role — they're
 * loading/empty placeholders, not status worth narrating (the
 * Skeleton primitive already owns the loading aria-live for those
 * paths).
 */
import type { ReactNode } from "react";

export interface NoticeRowProps {
  readonly tone: "alert" | "muted";
  readonly children: ReactNode;
}

export function NoticeRow(props: NoticeRowProps): JSX.Element {
  return (
    <div
      {...(props.tone === "alert" ? { role: "alert" } : {})}
      style={{
        color: props.tone === "alert" ? "var(--alert)" : "var(--ink-3)",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        padding: "16px 0",
      }}
    >
      {props.children}
    </div>
  );
}
