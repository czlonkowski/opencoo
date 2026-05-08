/**
 * CredentialForm — auto-rendered embedded form (NOT a modal,
 * PR 29 / plan #131; UX token-binding spec).
 *
 * Reads a JSON-Schema-shaped credential descriptor and emits one
 * field row per property. `secret: true` properties render
 * masked + carry the `● stored encrypted` mono-note below. The
 * filled-disc glyph in `--healthy` cues "compiled / persisted
 * safely" without claiming any specific cryptographic property
 * the UI itself can verify.
 *
 * Design-system bindings:
 *   - field-row gap: var(--space-5)
 *   - label: var(--font-mono), 600, var(--fs-micro), uppercase
 *     + inline `· required` (var(--ink)) or `· optional`
 *     (var(--fg-4)) marker
 *   - description: var(--font-sans), 400, var(--fs-small),
 *     var(--fg-3)
 *   - input: var(--font-mono), border 1px solid var(--rule) →
 *     focus var(--ink) → error var(--alert)
 *   - encrypted-note: ● filled-disc glyph in var(--healthy)
 *     + mono `stored encrypted` in var(--fg-3)
 *   - submit: bg var(--ink), fg var(--paper); align flex-end
 *
 * Hard-nos honored:
 *   - NO advisory amber (admin config, not agent layer).
 *   - NO `--wiki` teal (credentials aren't compiled knowledge).
 *   - NO eye-toggle / show-password on secret fields.
 *   - NO copy / regenerate icons (those belong on a separate
 *     secret-display surface).
 *   - secret-field placeholder is empty (NEVER a real-looking
 *     value).
 *   - NO emoji on the encrypted-note (filled-disc from logo
 *     trio).
 *   - NO card border around each field row.
 *   - NO spinner on submit (label-swap to `saving…` mono).
 *   - schema's raw JSON path / $ref text NEVER rendered in UI.
 *
 * Motion: error-state border-color transitions over 180ms with
 * var(--ease-write); fields fade-in staggered 20ms apart, max
 * 6 fields staggered (cap to avoid waterfall).
 */
import { Fragment, useState, type CSSProperties, type FormEventHandler } from "react";
import { useTranslation } from "react-i18next";

import { GlyphFilledDisc } from "./Glyph.js";

export interface CredentialSchemaProperty {
  readonly type: "string";
  readonly description?: string;
  readonly secret?: boolean;
}

export interface CredentialSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, CredentialSchemaProperty>>;
  readonly required: ReadonlyArray<string>;
}

export interface CredentialFormProps {
  readonly schema: CredentialSchema;
  readonly onSubmit: (values: Record<string, string>) => Promise<void> | void;
  readonly submitLabel?: string;
}

const FORM_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
  maxWidth: 560,
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
  display: "flex",
  alignItems: "baseline",
  gap: "var(--space-2)",
};

// Section heading sits above the FIRST field of a `section.leaf`
// run. Same t-micro token treatment as the field label so the
// hierarchy reads as one mono column with a slightly stronger
// upper line. We deliberately do NOT introduce a new design
// token here — see CLAUDE.md / design-system rules.
const SECTION_HEADING_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
  margin: 0,
  paddingTop: "var(--space-2)",
};

/**
 * Split `auth.personal_access_token` into `["auth",
 * "personal_access_token"]`. Splits on the FIRST `.` only —
 * leaves any trailing dots inside the leaf alone (defensive;
 * the engine schemas don't currently nest deeper, but if they
 * did, we'd want the leaf to keep showing meaningfully rather
 * than fragment further).
 */
function splitFieldKey(key: string): { section: string | undefined; leaf: string } {
  const idx = key.indexOf(".");
  if (idx === -1) return { section: undefined, leaf: key };
  return { section: key.slice(0, idx), leaf: key.slice(idx + 1) };
}

/**
 * Humanise an underscored identifier for display:
 *   `personal_access_token` → `Personal access token`
 *   `webhook_secret`        → `Webhook secret`
 *   `x_hook_secret`         → `X hook secret`
 *
 * First-letter capital only — NOT title-case-every-word. Per
 * design-system rules the surrounding label-row keeps its
 * uppercase mono treatment via CSS `text-transform`; this
 * function only normalises the underlying string so we don't
 * leak schema dot-paths.
 */
function humanise(s: string): string {
  if (s.length === 0) return s;
  const spaced = s.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

const REQUIRED_MARKER_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  color: "var(--ink)",
};

const OPTIONAL_MARKER_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 400,
  fontSize: "var(--fs-micro)",
  color: "var(--fg-4)",
};

const DESCRIPTION_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontWeight: 400,
  fontSize: "var(--fs-small)",
  lineHeight: "var(--lh-small)",
  color: "var(--fg-3)",
  margin: 0,
};

const INPUT_BASE_STYLE: CSSProperties = {
  background: "var(--paper)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-4)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
  color: "var(--fg-1)",
  transition: "border-color 180ms var(--ease-write)",
  width: "100%",
};

const ENCRYPTED_NOTE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  color: "var(--fg-3)",
};

const VALIDATION_MSG_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--alert)",
  margin: 0,
};

const SUBMIT_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
};

const SUBMIT_BTN_BASE_STYLE: CSSProperties = {
  background: "var(--ink)",
  color: "var(--paper)",
  border: "1px solid var(--ink)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-body)",
  cursor: "pointer",
};

interface FieldRowProps {
  readonly fieldKey: string;
  readonly labelText: string;
  readonly prop: CredentialSchemaProperty;
  readonly required: boolean;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly error: string | undefined;
  readonly staggerIndex: number;
}

function FieldRow(props: FieldRowProps): JSX.Element {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const isSecret = props.prop.secret === true;
  const inputId = `cred-${props.fieldKey}`;
  const inputStyle: CSSProperties = {
    ...INPUT_BASE_STYLE,
    ...(focused ? { borderColor: "var(--ink)" } : {}),
    ...(props.error !== undefined ? { borderColor: "var(--alert)" } : {}),
  };
  // Stagger cap at 6 — beyond that the delay clamps to 5 *
  // 20ms = 100ms so we don't waterfall a long form.
  const cappedIndex = Math.min(props.staggerIndex, 5);
  const rowStyle: CSSProperties = {
    ...ROW_STYLE,
  };
  return (
    <div
      className="opencoo-field-enter"
      style={{
        ...rowStyle,
        // CSS var consumed by the keyframes' animation-delay.
        ["--field-stagger-delay" as string]: `${cappedIndex * 20}ms`,
      } as CSSProperties}
    >
      <label htmlFor={inputId} style={LABEL_STYLE}>
        <span>{props.labelText}</span>
        <span
          style={
            props.required
              ? REQUIRED_MARKER_STYLE
              : OPTIONAL_MARKER_STYLE
          }
        >
          {props.required
            ? `· ${t("credentialForm.required")}`
            : `· ${t("credentialForm.optional")}`}
        </span>
      </label>
      {props.prop.description !== undefined ? (
        <p style={DESCRIPTION_STYLE}>{props.prop.description}</p>
      ) : null}
      <input
        id={inputId}
        name={props.fieldKey}
        type={isSecret ? "password" : "text"}
        autoComplete={isSecret ? "new-password" : "off"}
        value={props.value}
        onChange={(e): void => props.onChange(e.target.value)}
        onFocus={(): void => setFocused(true)}
        onBlur={(): void => setFocused(false)}
        // Spec: secret-field placeholder NEVER a real-looking
        // value. Empty placeholder is the safe choice.
        placeholder=""
        style={inputStyle}
        data-secret={isSecret ? "true" : undefined}
      />
      {isSecret ? (
        <span style={ENCRYPTED_NOTE_STYLE}>
          <GlyphFilledDisc
            size={10}
            title="stored encrypted"
            style={{ color: "var(--healthy)" }}
          />
          {t("credentialForm.encryptedNote")}
        </span>
      ) : null}
      {props.error !== undefined ? (
        <p style={VALIDATION_MSG_STYLE}>{props.error}</p>
      ) : null}
    </div>
  );
}

export function CredentialForm(props: CredentialFormProps): JSX.Element {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const onSubmit: FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};
    for (const req of props.schema.required) {
      if ((values[req] ?? "").length === 0) {
        newErrors[req] = t("credentialForm.requiredError");
      }
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    setSubmitting(true);
    try {
      await props.onSubmit(values);
    } finally {
      setSubmitting(false);
    }
  };

  const fieldKeys = Object.keys(props.schema.properties);
  const submitStyle: CSSProperties = {
    ...SUBMIT_BTN_BASE_STYLE,
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

  // Track the most recently rendered section so we emit the
  // section heading exactly once, above its FIRST field. The
  // internal data shape stays dot-keyed (see `setValues` below)
  // — this is purely a render-time transformation.
  //
  // `lastSection` is reset to undefined whenever a non-dotted key
  // appears between two dotted runs of the same section (Copilot
  // PR-Q11 review): an interleaving like `auth.x → baseUrl →
  // auth.y` should re-emit the "Auth" heading on `auth.y` so the
  // visual grouping mirrors the actual layout. Without the reset,
  // `lastSection` would still equal "auth" when `auth.y` lands and
  // the heading would be silently skipped.
  let lastSection: string | undefined;

  return (
    <form noValidate onSubmit={onSubmit} style={FORM_STYLE}>
      {fieldKeys.map((key, idx) => {
        const prop = props.schema.properties[key];
        if (prop === undefined) return null;
        const { section, leaf } = splitFieldKey(key);
        const labelText = humanise(leaf);
        const showSectionHeading =
          section !== undefined && section !== lastSection;
        // Update the cursor for both dotted and non-dotted keys so
        // a re-entry into a previously-shown section after a
        // non-dotted gap re-emits its heading (see comment above).
        lastSection = section;
        return (
          <Fragment key={key}>
            {showSectionHeading && section !== undefined ? (
              <h3 style={SECTION_HEADING_STYLE} data-section-heading>
                {humanise(section)}
              </h3>
            ) : null}
            <FieldRow
              fieldKey={key}
              labelText={labelText}
              prop={prop}
              required={props.schema.required.includes(key)}
              value={values[key] ?? ""}
              onChange={(v): void => {
                setValues((cur) => ({ ...cur, [key]: v }));
                if (errors[key] !== undefined) {
                  setErrors((er) => {
                    const next = { ...er };
                    delete next[key];
                    return next;
                  });
                }
              }}
              error={errors[key]}
              staggerIndex={idx}
            />
          </Fragment>
        );
      })}
      <div style={SUBMIT_ROW_STYLE}>
        <button type="submit" disabled={submitting} style={submitStyle}>
          {submitting
            ? t("credentialForm.saving")
            : (props.submitLabel ?? t("common.save"))}
        </button>
      </div>
    </form>
  );
}
