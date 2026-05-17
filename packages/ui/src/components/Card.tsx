/**
 * Card surface — design-system-conformant container. No
 * drop-shadows for elevation (depth = border + bg shift per
 * CLAUDE.md hard-nos). Radius capped at 6px.
 *
 * PR-C5 (wave-16, phase-a appendix #16): opt-in `clickable` prop
 * upgrades the root from `<div>` to `<button type="button">` and
 * attaches the `opencoo-hover-card` class so the design-system
 * hover recipe (60ms ease-transform, background-color + border-
 * color shift, no shadow / no scale) wires through. A clickable
 * Card is a real `<button>` so it inherits keyboard semantics
 * (Enter/Space → click), the global `:focus-visible` ring from
 * app.css, and the `role=button` exposed to assistive tech.
 */
import type {
  CSSProperties,
  MouseEventHandler,
  ReactNode,
} from "react";

interface BaseProps {
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly style?: CSSProperties;
}

interface StaticProps extends BaseProps {
  readonly clickable?: false;
  readonly onClick?: never;
}

interface ClickableProps extends BaseProps {
  readonly clickable: true;
  readonly onClick: MouseEventHandler<HTMLButtonElement>;
}

export type CardProps = StaticProps | ClickableProps;

const ROOT_STYLE: CSSProperties = {
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-l)",
  background: "var(--paper)",
  padding: 0,
  display: "flex",
  flexDirection: "column",
};

export function Card(props: CardProps): JSX.Element {
  const body = (
    <>
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
    </>
  );

  if (props.clickable === true) {
    return (
      <button
        type="button"
        onClick={props.onClick}
        className="opencoo-hover-card"
        style={{
          ...ROOT_STYLE,
          textAlign: "left",
          font: "inherit",
          color: "inherit",
          cursor: "pointer",
          ...props.style,
        }}
      >
        {body}
      </button>
    );
  }

  return (
    <div style={{ ...ROOT_STYLE, ...props.style }}>{body}</div>
  );
}
