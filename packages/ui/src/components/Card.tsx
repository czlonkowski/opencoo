/**
 * Card surface — design-system-conformant container. No
 * drop-shadows for elevation (depth = border + bg shift per
 * CLAUDE.md hard-nos). Radius capped at 6px.
 */
import type { CSSProperties, ReactNode } from "react";

export interface CardProps {
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly style?: CSSProperties;
}

export function Card(props: CardProps): JSX.Element {
  return (
    <div
      style={{
        border: "1px solid var(--rule)",
        borderRadius: "var(--radius-l)",
        background: "var(--paper)",
        padding: 0,
        display: "flex",
        flexDirection: "column",
        ...props.style,
      }}
    >
      {props.title !== undefined ? (
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--rule)",
            background: "var(--paper-2)",
            borderTopLeftRadius: "var(--radius-l)",
            borderTopRightRadius: "var(--radius-l)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              fontSize: "var(--fs-body)",
              color: "var(--ink)",
            }}
          >
            {props.title}
          </div>
          {props.subtitle !== undefined ? (
            <div
              style={{
                marginTop: 4,
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-micro)",
                color: "var(--ink-3)",
                letterSpacing: "0.04em",
              }}
            >
              {props.subtitle}
            </div>
          ) : null}
        </div>
      ) : null}
      <div style={{ padding: "16px" }}>{props.children}</div>
    </div>
  );
}
