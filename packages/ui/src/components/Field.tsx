/**
 * Form field — label + input wrapper. References design-system
 * vars exclusively (font scale, radii, border colors).
 *
 * Supports two input modes:
 *   - Controlled (default): pass `value` + `onChange`. React
 *     owns the input value across renders.
 *   - Uncontrolled: pass `inputRef` (+ optional `defaultValue`)
 *     instead of `value`/`onChange`. The DOM owns the value;
 *     the caller reads it on submit via `inputRef.current.value`.
 *     This is the mode used by forms that need to survive
 *     external value-setters (password-manager autofill,
 *     1Password / Bitwarden, etc) — controlled inputs fight
 *     reconciliation when an external script JS-sets the value
 *     via the native value setter, and React swaps the field
 *     state on the next render (PR-Z9 / G12).
 */
import type { ChangeEventHandler, Ref, ReactNode } from "react";

export interface FieldProps {
  readonly label: ReactNode;
  readonly name: string;
  readonly value?: string;
  readonly onChange?: ChangeEventHandler<HTMLInputElement>;
  readonly placeholder?: string;
  readonly type?: "text" | "password" | "email";
  readonly required?: boolean;
  readonly helper?: ReactNode;
  readonly error?: string;
  /** When true the input renders monospaced — useful for IDs +
   *  paths (CLAUDE.md "JetBrains Mono = paths, IDs, micro-labels"). */
  readonly mono?: boolean;
  readonly secret?: boolean;
  /** Uncontrolled-mode escape hatch. When provided, the input is
   *  rendered without a React-owned `value`, and the caller reads
   *  the live DOM value via this ref. Pair with `defaultValue`
   *  for an initial value. See file header for rationale. */
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly defaultValue?: string;
}

export function Field(props: FieldProps): JSX.Element {
  const inputId = `field-${props.name}`;
  // Controlled-mode props are only spread onto the input when
  // BOTH `value` and `onChange` are present — otherwise React
  // warns about a controlled input becoming uncontrolled (or
  // vice-versa).
  const controlled = props.value !== undefined && props.onChange !== undefined;
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
        {...(controlled
          ? { value: props.value, onChange: props.onChange }
          : props.defaultValue !== undefined
            ? { defaultValue: props.defaultValue }
            : {})}
        {...(props.inputRef !== undefined ? { ref: props.inputRef } : {})}
        placeholder={props.placeholder}
        required={props.required}
        autoComplete={props.secret === true ? "new-password" : "off"}
        aria-invalid={props.error !== undefined ? true : undefined}
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
