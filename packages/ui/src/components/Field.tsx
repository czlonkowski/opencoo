/**
 * Form field — label + input wrapper. References design-system
 * vars exclusively (font scale, radii, border colors).
 */
import type { ChangeEventHandler, ReactNode } from "react";

export interface FieldProps {
  readonly label: ReactNode;
  readonly name: string;
  readonly value: string;
  readonly onChange: ChangeEventHandler<HTMLInputElement>;
  readonly placeholder?: string;
  readonly type?: "text" | "password" | "email";
  readonly required?: boolean;
  readonly helper?: ReactNode;
  readonly error?: string;
  /** When true the input renders monospaced — useful for IDs +
   *  paths (CLAUDE.md "JetBrains Mono = paths, IDs, micro-labels"). */
  readonly mono?: boolean;
  readonly secret?: boolean;
}

export function Field(props: FieldProps): JSX.Element {
  const inputId = `field-${props.name}`;
  return (
    <label
      htmlFor={inputId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontFamily: "var(--font-sans)",
        fontSize: "var(--fs-small)",
        color: "var(--ink-2)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-micro)",
          color: "var(--ink-3)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {props.label}
        {props.required === true ? (
          <span style={{ color: "var(--alert)" }} aria-hidden="true">
            {" "}
            *
          </span>
        ) : null}
      </span>
      <input
        id={inputId}
        name={props.name}
        type={props.secret === true ? "password" : (props.type ?? "text")}
        value={props.value}
        onChange={props.onChange}
        placeholder={props.placeholder}
        required={props.required}
        autoComplete={props.secret === true ? "new-password" : "off"}
        data-secret={props.secret === true ? "true" : undefined}
        style={{
          fontFamily: props.mono === true ? "var(--font-mono)" : "var(--font-sans)",
          fontSize: "var(--fs-body)",
          padding: "8px 10px",
          background: "var(--paper)",
          border: "1px solid",
          borderColor: props.error !== undefined ? "var(--alert)" : "var(--rule)",
          borderRadius: "var(--radius-m)",
          color: "var(--ink)",
        }}
      />
      {props.helper !== undefined ? (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-micro)",
            color: "var(--ink-3)",
            letterSpacing: "0.04em",
          }}
        >
          {props.helper}
        </span>
      ) : null}
      {props.error !== undefined ? (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-micro)",
            color: "var(--alert)",
            letterSpacing: "0.04em",
          }}
        >
          {props.error}
        </span>
      ) : null}
    </label>
  );
}
