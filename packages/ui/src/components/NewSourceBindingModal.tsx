/**
 * NewSourceBindingModal — `+ New binding` flow on the Sources
 * tab (phase-a appendix #2).
 *
 * Two-step modal:
 *   1. Picker: adapter + target_domain + review_mode
 *      (review_mode prefilled from `defaultReviewModeFor`).
 *   2. Credentials: dynamic form rendered from the adapter's
 *      JSON-Schema descriptor. Webhook adapters render BOTH
 *      `auth.*` AND `webhook_secret.*` fields.
 *
 * The "render config UI from a JSON Schema, not from
 * adapter-specific code" rule is in CLAUDE.md (Adapter
 * boundaries). The schema for each adapter comes from
 * `GET /api/admin/adapters` — same source the server validator
 * uses (no drift).
 *
 * Hard-nos honored:
 *   - primary CTA ink-on-paper (admin chrome).
 *   - secret fields rendered as type=password (NEVER plain text).
 *   - submit body never re-echoes an unknown adapter slug.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Field } from "./Field.js";
import { Modal } from "./Modal.js";
import { PickerSelect } from "./PickerSelect.js";
import { fetchAdmin } from "../lib/api.js";

const REVIEW_MODES = ["auto", "approve", "review"] as const;
const TRANSCRIPTION_ADAPTER_SLUGS = ["fireflies"] as const;
type ReviewMode = (typeof REVIEW_MODES)[number];
type DomainClass = "knowledge" | "catalog-workflows" | "catalog-skills";

/** Pure helper duplicated from `@opencoo/shared/source-adapter`'s
 *  `defaultReviewModeFor` so the UI doesn't need a node-only
 *  shared import for one branch. The shared module remains the
 *  authoritative server-side source. */
function defaultReviewModeFor(args: {
  readonly adapterSlug: string;
  readonly domainClass: DomainClass;
}): ReviewMode {
  if ((TRANSCRIPTION_ADAPTER_SLUGS as readonly string[]).includes(args.adapterSlug)) {
    return "approve";
  }
  if (args.domainClass === "catalog-skills") return "approve";
  return "auto";
}

interface CredentialFieldDescriptor {
  readonly type: "string";
  readonly description?: string;
  readonly secret?: boolean;
}

interface PollingSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, CredentialFieldDescriptor>>;
  readonly required: readonly string[];
}

interface WebhookSchema {
  readonly type: "object";
  readonly properties: {
    readonly auth: PollingSchema;
    readonly webhook_secret: PollingSchema;
  };
  readonly required: readonly ("auth" | "webhook_secret")[];
}

type AnyCredentialSchema = PollingSchema | WebhookSchema;

interface AdapterDescriptor {
  readonly slug: string;
  readonly mode: "polling" | "webhook";
  readonly credentialSchema: AnyCredentialSchema;
}

interface DomainRow {
  readonly id: string;
  readonly slug: string;
  readonly class: DomainClass;
}

export interface NewSourceBindingModalProps {
  readonly onCreated: (created: { id: string }) => void;
  readonly onClose: () => void;
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

const FIELDS_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

const SECTION_HEADER_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  margin: 0,
};

export function NewSourceBindingModal(
  props: NewSourceBindingModalProps,
): JSX.Element {
  const { t } = useTranslation();
  const [step, setStep] = useState<"picker" | "credentials">("picker");
  const [adapters, setAdapters] = useState<readonly AdapterDescriptor[]>([]);
  const [domains, setDomains] = useState<readonly DomainRow[]>([]);
  const [adapterSlug, setAdapterSlug] = useState<string>("");
  const [targetDomainSlug, setTargetDomainSlug] = useState<string>("");
  const [reviewMode, setReviewMode] = useState<ReviewMode>("auto");
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>(
    {},
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const fetchOpts =
    props.fetchImpl !== undefined
      ? { fetchImpl: props.fetchImpl as typeof fetch }
      : {};

  // Initial hydration — adapters + domains.
  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const adaptersResp = await fetchAdmin<{
          adapters: readonly AdapterDescriptor[];
        }>("/api/admin/adapters", fetchOpts);
        const domainsResp = await fetchAdmin<{
          rows: ReadonlyArray<{
            id: string;
            slug: string;
            class: string;
          }>;
        }>("/api/admin/domains", fetchOpts);
        setAdapters(adaptersResp.adapters);
        const dRows: DomainRow[] = domainsResp.rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          class: r.class as DomainClass,
        }));
        setDomains(dRows);
        const firstAdapter = [...adaptersResp.adapters]
          .sort((a, b) => a.slug.localeCompare(b.slug))[0];
        const firstDomain = dRows[0];
        if (firstAdapter !== undefined) setAdapterSlug(firstAdapter.slug);
        if (firstDomain !== undefined) setTargetDomainSlug(firstDomain.slug);
      } catch (err) {
        setErrors({
          form:
            err instanceof Error
              ? err.message
              : t("sources.create.errors.generic"),
        });
      }
    })();
    // Mount-only fetch — fetchOpts is stable for the lifetime of this modal.
  }, []);

  // Recompute review_mode prefill whenever the
  // (adapter, domain) pair changes, BEFORE the operator opens
  // the credentials step. Operator can override.
  useEffect(() => {
    const domain = domains.find((d) => d.slug === targetDomainSlug);
    if (domain === undefined) return;
    const def = defaultReviewModeFor({
      adapterSlug,
      domainClass: domain.class,
    });
    setReviewMode(def);
  }, [adapterSlug, targetDomainSlug, domains]);

  const currentAdapter: AdapterDescriptor | undefined = useMemo(
    () => adapters.find((a) => a.slug === adapterSlug),
    [adapters, adapterSlug],
  );

  const validateCredentials = (): boolean => {
    if (currentAdapter === undefined) return false;
    const next: Record<string, string> = {};
    if (currentAdapter.mode === "polling") {
      const polling = currentAdapter.credentialSchema as PollingSchema;
      for (const req of polling.required) {
        if ((credentialValues[req] ?? "").length === 0) {
          next[req] = t("sources.create.errors.requiredField");
        }
      }
    } else {
      const webhook = currentAdapter.credentialSchema as WebhookSchema;
      for (const req of webhook.properties.auth.required) {
        if ((credentialValues[`auth.${req}`] ?? "").length === 0) {
          next[`auth.${req}`] = t("sources.create.errors.requiredField");
        }
      }
      for (const req of webhook.properties.webhook_secret.required) {
        if ((credentialValues[`webhook_secret.${req}`] ?? "").length === 0) {
          next[`webhook_secret.${req}`] = t(
            "sources.create.errors.requiredField",
          );
        }
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (): Promise<void> => {
    if (currentAdapter === undefined) return;
    if (!validateCredentials()) return;
    setSubmitting(true);
    try {
      let credentials: Record<string, unknown>;
      if (currentAdapter.mode === "polling") {
        credentials = {};
        for (const k of Object.keys(currentAdapter.credentialSchema.properties)) {
          credentials[k] = credentialValues[k] ?? "";
        }
      } else {
        const webhook = currentAdapter.credentialSchema as WebhookSchema;
        const auth: Record<string, string> = {};
        for (const k of Object.keys(webhook.properties.auth.properties)) {
          auth[k] = credentialValues[`auth.${k}`] ?? "";
        }
        const webhookSecret: Record<string, string> = {};
        for (const k of Object.keys(webhook.properties.webhook_secret.properties)) {
          webhookSecret[k] = credentialValues[`webhook_secret.${k}`] ?? "";
        }
        credentials = { auth, webhook_secret: webhookSecret };
      }
      const result = await fetchAdmin<{ id: string }>(
        "/api/admin/source-bindings",
        {
          method: "POST",
          body: {
            adapter_slug: adapterSlug,
            target_domain_slug: targetDomainSlug,
            review_mode: reviewMode,
            credentials,
          },
          ...fetchOpts,
        },
      );
      props.onCreated(result);
    } catch (err) {
      setErrors({
        form:
          err instanceof Error
            ? err.message
            : t("sources.create.errors.generic"),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={t("sources.create.title")}
      subtitle={t("sources.create.subtitle")}
      onClose={props.onClose}
      maxWidth={620}
    >
      {step === "picker" ? (
        <div style={FIELDS_STYLE}>
          <PickerSelect
            name="adapter_slug"
            label={t("sources.create.fields.adapter")}
            value={adapterSlug}
            onChange={setAdapterSlug}
            options={adapters
              .map((a) => ({ value: a.slug, label: a.slug }))
              .sort((a, b) => a.label.localeCompare(b.label))}
          />
          <PickerSelect
            name="target_domain_slug"
            label={t("sources.create.fields.targetDomain")}
            value={targetDomainSlug}
            onChange={setTargetDomainSlug}
            options={domains.map((d) => ({ value: d.slug, label: d.slug }))}
          />
          <PickerSelect
            name="review_mode"
            label={t("sources.create.fields.reviewMode")}
            value={reviewMode}
            onChange={(v): void => setReviewMode(v as ReviewMode)}
            options={REVIEW_MODES.map((r) => ({ value: r, label: r }))}
          />
          {errors["form"] !== undefined ? (
            <p
              role="alert"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-micro)",
                color: "var(--alert)",
                margin: 0,
              }}
            >
              {errors["form"]}
            </p>
          ) : null}
          <div style={FOOTER_STYLE}>
            <Btn variant="ghost" onClick={props.onClose}>
              {t("common.cancel")}
            </Btn>
            <Btn
              variant="primary"
              onClick={(): void => setStep("credentials")}
              disabled={
                adapterSlug.length === 0 || targetDomainSlug.length === 0
              }
            >
              {t("sources.create.next")}
            </Btn>
          </div>
        </div>
      ) : (
        <CredentialsStep
          adapter={currentAdapter}
          values={credentialValues}
          errors={errors}
          submitting={submitting}
          onValueChange={(key, v): void => {
            setCredentialValues((cur) => ({ ...cur, [key]: v }));
            if (errors[key] !== undefined) {
              setErrors((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
              });
            }
          }}
          onBack={(): void => setStep("picker")}
          onSubmit={(): void => {
            void submit();
          }}
        />
      )}
    </Modal>
  );
}

interface CredentialsStepProps {
  readonly adapter: AdapterDescriptor | undefined;
  readonly values: Record<string, string>;
  readonly errors: Record<string, string>;
  readonly submitting: boolean;
  readonly onValueChange: (key: string, value: string) => void;
  readonly onBack: () => void;
  readonly onSubmit: () => void;
}

function CredentialsStep(props: CredentialsStepProps): JSX.Element {
  const { t } = useTranslation();
  if (props.adapter === undefined) {
    return <div>{t("common.loading")}</div>;
  }
  const isWebhook = props.adapter.mode === "webhook";
  return (
    <div style={FIELDS_STYLE}>
      {isWebhook ? (
        <>
          <h3 style={SECTION_HEADER_STYLE}>{t("sources.create.section.auth")}</h3>
          <SchemaFields
            schema={
              (props.adapter.credentialSchema as WebhookSchema).properties.auth
            }
            pathPrefix="auth"
            values={props.values}
            errors={props.errors}
            onValueChange={props.onValueChange}
          />
          <h3 style={SECTION_HEADER_STYLE}>
            {t("sources.create.section.webhookSecret")}
          </h3>
          <SchemaFields
            schema={
              (props.adapter.credentialSchema as WebhookSchema).properties
                .webhook_secret
            }
            pathPrefix="webhook_secret"
            values={props.values}
            errors={props.errors}
            onValueChange={props.onValueChange}
          />
        </>
      ) : (
        <SchemaFields
          schema={props.adapter.credentialSchema as PollingSchema}
          pathPrefix=""
          values={props.values}
          errors={props.errors}
          onValueChange={props.onValueChange}
        />
      )}
      {props.errors["form"] !== undefined ? (
        <p
          role="alert"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-micro)",
            color: "var(--alert)",
            margin: 0,
          }}
        >
          {props.errors["form"]}
        </p>
      ) : null}
      <div style={FOOTER_STYLE}>
        <Btn variant="ghost" onClick={props.onBack}>
          {t("sources.create.back")}
        </Btn>
        <Btn
          variant="primary"
          disabled={props.submitting}
          onClick={props.onSubmit}
        >
          {props.submitting
            ? t("sources.create.submitting")
            : t("sources.create.submit")}
        </Btn>
      </div>
    </div>
  );
}

interface SchemaFieldsProps {
  readonly schema: PollingSchema;
  readonly pathPrefix: string;
  readonly values: Record<string, string>;
  readonly errors: Record<string, string>;
  readonly onValueChange: (key: string, value: string) => void;
}

function SchemaFields(props: SchemaFieldsProps): JSX.Element {
  const fields = Object.entries(props.schema.properties);
  return (
    <>
      {fields.map(([key, descriptor]) => {
        const fullKey =
          props.pathPrefix.length > 0 ? `${props.pathPrefix}.${key}` : key;
        const required = props.schema.required.includes(key);
        return (
          <Field
            key={fullKey}
            name={fullKey}
            label={fullKey}
            value={props.values[fullKey] ?? ""}
            onChange={(e): void => props.onValueChange(fullKey, e.target.value)}
            secret={descriptor.secret === true}
            required={required}
            {...(descriptor.description !== undefined
              ? { helper: descriptor.description }
              : {})}
            {...(props.errors[fullKey] !== undefined
              ? { error: props.errors[fullKey] }
              : {})}
          />
        );
      })}
    </>
  );
}
