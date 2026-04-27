/**
 * PickerSelect — labeled <select> matching the design-system
 * field shape (mono uppercase micro-label above the control).
 *
 * Used by `NewDomainModal` (class + locale) and
 * `NewSourceBindingModal` (adapter + target_domain + review_mode).
 * Extracted from NewSourceBindingModal so both modals render the
 * same label + control treatment without duplicating ~30 LOC of
 * inline styles per form.
 */
import type { CSSProperties } from "react";

const LABEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--ink-2)",
};

const CAPTION_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--ink-3)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const SELECT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
  padding: "8px 10px",
  background: "var(--paper)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  color: "var(--ink)",
};

export interface PickerOption {
  readonly value: string;
  readonly label: string;
}

export interface PickerSelectProps {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly options: readonly PickerOption[];
}

export function PickerSelect(props: PickerSelectProps): JSX.Element {
  return (
    <label style={LABEL_STYLE}>
      <span style={CAPTION_STYLE}>{props.label}</span>
      <select
        name={props.name}
        value={props.value}
        onChange={(e): void => props.onChange(e.target.value)}
        style={SELECT_STYLE}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
