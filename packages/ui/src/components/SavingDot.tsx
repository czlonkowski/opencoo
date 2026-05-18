/**
 * `SavingDot` — 8px companion cue for `useOptimisticPatch`-wired
 * fields (PR-B5, wave-16, phase-a appendix #16).
 *
 * Visual contract:
 *   - 8px diameter circle.
 *   - Color encodes lifecycle state:
 *       saving    → `--ink-3`
 *       success   → brief flash `--healthy`, fades to transparent
 *       rollback  → `--alert` until the next setValue clears it
 *       idle      → transparent (still rendered so the layout doesn't
 *                   shift — no CLS on transitions)
 *   - One-shot 600ms opacity fade using `--ease-write` on each state
 *     transition. NO animation loop (design-system "exactly one
 *     loop" invariant — heartbeat-pulse only).
 *   - The `prefers-reduced-motion: reduce` media query is honored
 *     transitively: callers wire `transition` to the `--ease-write`
 *     token; the global C5 reduced-motion stylesheet clamps both
 *     `--ease-write` and `--ease-transform` to near-zero. The B5
 *     saving-cue is purely informative; the operator with reduced-
 *     motion preference sees the same state changes instantly.
 *
 * The dot is `aria-hidden` because B7's toast already announces
 * success/failure via `role="status"` / `role="alert"`. The dot is
 * a redundant VISUAL cue, not an SR cue.
 */
import { useEffect, useState, type CSSProperties } from "react";

export type SavingDotState = "idle" | "saving" | "success" | "error";

interface SavingDotProps {
  readonly state: SavingDotState;
  /** Optional aria-label override; default is `aria-hidden`. */
  readonly ariaLabel?: string;
}

const BASE_STYLE: CSSProperties = {
  display: "inline-block",
  width: 8,
  height: 8,
  borderRadius: "50%",
  marginLeft: 8,
  verticalAlign: "middle",
  transition:
    "opacity 600ms var(--ease-write), background-color 600ms var(--ease-write)",
  flex: "0 0 auto",
};

/** A success flash lingers briefly then fades to transparent. We
 *  keep the success color visible for ~600ms so the operator
 *  registers it; after that the dot transitions back to the
 *  transparent "idle" appearance via the one-shot opacity fade. */
const SUCCESS_FLASH_MS = 600;

export function SavingDot(props: SavingDotProps): JSX.Element {
  const { state } = props;
  // We render an internal "post-success" state that follows
  // success → idle after SUCCESS_FLASH_MS, so the green flash
  // doesn't stick. Failure (`error`) remains until the parent
  // resets it (next setValue or explicit clear).
  const [phase, setPhase] = useState<SavingDotState>(state);
  useEffect((): (() => void) | undefined => {
    setPhase(state);
    if (state === "success") {
      const handle = window.setTimeout((): void => {
        setPhase("idle");
      }, SUCCESS_FLASH_MS);
      return (): void => {
        window.clearTimeout(handle);
      };
    }
    return undefined;
  }, [state]);

  const background = colorFor(phase);
  const opacity = phase === "idle" ? 0 : 1;

  return (
    <span
      role={props.ariaLabel !== undefined ? "status" : undefined}
      aria-label={props.ariaLabel}
      aria-hidden={props.ariaLabel === undefined ? true : undefined}
      data-saving-state={phase}
      style={{
        ...BASE_STYLE,
        background,
        opacity,
      }}
    />
  );
}

function colorFor(state: SavingDotState): string {
  switch (state) {
    case "saving":
      return "var(--ink-3)";
    case "success":
      return "var(--healthy)";
    case "error":
      return "var(--alert)";
    case "idle":
      return "transparent";
  }
}
