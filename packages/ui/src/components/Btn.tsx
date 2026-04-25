/**
 * Button (Btn) — migrated verbatim from
 * design_system/ui_kits/management-console/Chrome.jsx.
 *
 * Variants map to the design-system semantic tokens — no color
 * literals; no fully-rounded pills (radii capped at 6px per
 * CLAUDE.md "Hard nos"). The advisory variant is reserved for
 * agent-layer CTAs (Heartbeat approve, etc.) — see
 * design_system/README.md.
 */
import type { CSSProperties, MouseEventHandler, ReactNode } from "react";

type Variant = "primary" | "ghost" | "advisory" | "subtle";

const STYLES: Record<Variant, CSSProperties> = {
  primary: {
    background: "var(--ink)",
    color: "var(--paper)",
    borderColor: "var(--ink)",
  },
  ghost: {
    background: "transparent",
    color: "var(--ink)",
    borderColor: "var(--ink)",
  },
  advisory: {
    background: "var(--advisory)",
    color: "var(--ink)",
    borderColor: "var(--advisory-ink)",
  },
  subtle: {
    background: "var(--paper-2)",
    color: "var(--ink)",
    borderColor: "var(--rule)",
  },
};

export interface BtnProps {
  readonly variant?: Variant;
  readonly children: ReactNode;
  readonly onClick?: MouseEventHandler<HTMLButtonElement>;
  readonly kbd?: string;
  readonly disabled?: boolean;
  readonly type?: "button" | "submit";
}

export function Btn(props: BtnProps): JSX.Element {
  const variant = props.variant ?? "primary";
  const v = STYLES[variant];
  return (
    <button
      type={props.type ?? "button"}
      disabled={props.disabled}
      onClick={props.onClick}
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
        cursor: props.disabled ? "not-allowed" : "pointer",
        opacity: props.disabled ? 0.55 : 1,
        ...v,
      }}
    >
      {props.children}
      {props.kbd !== undefined ? (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            opacity: 0.65,
          }}
        >
          {props.kbd}
        </span>
      ) : null}
    </button>
  );
}
