/**
 * CredentialForm — renders a Management UI form against a
 * JSON-Schema-shaped `OutputCredentialSchema` from the engine
 * (PR 28 admin-API). Fields with `secret: true` are masked
 * (HTML `type="password"`) and carry the design-system helper
 * text "Stored encrypted at rest. Server never echoes it
 * back."
 *
 * The form's submit fires the parent-supplied `onSubmit` with
 * the form values. The form does NOT POST directly — the parent
 * route's submit handler decides which endpoint to call.
 */
import { useState, type FormEventHandler } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Field } from "./Field.js";

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

export function CredentialForm(props: CredentialFormProps): JSX.Element {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const handleChange = (key: string) =>
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      setValues((v) => ({ ...v, [key]: e.target.value }));
      setErrors((er) => {
        const next = { ...er };
        delete next[key];
        return next;
      });
    };

  const onSubmit: FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};
    for (const req of props.schema.required) {
      if ((values[req] ?? "").length === 0) {
        newErrors[req] = t("credentialForm.required");
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

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {fieldKeys.map((key) => {
        const prop = props.schema.properties[key];
        if (prop === undefined) return null;
        const isSecret = prop.secret === true;
        const helper = isSecret
          ? t("credentialForm.secretHelp")
          : prop.description;
        const fieldProps = {
          label: key,
          name: key,
          value: values[key] ?? "",
          onChange: handleChange(key),
          required: props.schema.required.includes(key),
          mono: !isSecret,
          secret: isSecret,
          ...(errors[key] !== undefined ? { error: errors[key] } : {}),
          ...(helper !== undefined ? { helper } : {}),
        };
        return <Field key={key} {...fieldProps} />;
      })}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn variant="primary" type="submit" disabled={submitting}>
          {props.submitLabel ?? t("common.save")}
        </Btn>
      </div>
    </form>
  );
}
