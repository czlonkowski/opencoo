/**
 * SourceBindingDetail — Sources row drill-down modal.
 *
 * PR-Q10 (phase-a appendix #9) — view-mode core:
 *   1. "What's the webhook URL I give Asana?" — formatted in
 *      mono with a copy button + healthy-toned confirmation flash
 *      (mirrors `CredentialForm`'s encrypted-note treatment).
 *   2. "Disable / Delete this binding" — both gated by an inline
 *      confirmation step, both routed through the CSRF-protected
 *      admin-API endpoints (PATCH + DELETE).
 *
 * PR-R2 (phase-a appendix #10) — Edit toggle:
 *   3. Operational settings (`bindingConfigSchema`) — fields
 *      rendered with `secret: false`. Save posts
 *      `PATCH {config}`.
 *   4. Rotate credentials (`credentialSchema`) — fields all
 *      empty (we never read existing plaintext); banner clarifies
 *      rotation is atomic + does not pause the binding. Save posts
 *      `PATCH {credentials}`.
 *
 *   When the operator changes BOTH config + credentials in one
 *   edit session, the UI sends TWO sequential PATCHes (config
 *   first, then credentials) — the discriminator on the route
 *   rejects mixed bodies because each intent is one audit verb.
 *
 * Modal shape mirrors `Modal.tsx` + `PatEntryModal.tsx` (the only
 * other admin modals on this surface). Hard-nos honored:
 *   - no gradients, no drop shadows for elevation, no backdrop
 *     blur, no pills (radii cap at 6/10), no emoji
 *   - lowercase `opencoo` in any future copy strings
 *   - copy success uses the filled-disc glyph in `--healthy`,
 *     same as the CredentialForm encrypted-note
 *   - rotation banner is informational (`--ink-3`), NEVER
 *     `--advisory` — that token is reserved for the agent layer.
 *   - `--alert` reserved for destructive surfaces (Disable/Delete).
 *
 * THREAT-MODEL §3.13 — every mutating endpoint is CSRF-gated
 * server-side; the SPA's `fetchAdmin` already mirrors the
 * `opencoo_csrf` cookie as `X-CSRF-Token` for any PATCH/DELETE.
 * The webhook URL itself is the binding's UUID — operators sharing
 * it externally is by design (it is the public webhook target).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { GlyphFilledDisc } from "./Glyph.js";
import { Modal } from "./Modal.js";
import {
  ApiAuthError,
  ApiTransientError,
  ApiValidationError,
  fetchAdmin,
  fetchOptsFor,
} from "../lib/api.js";
import type { SourceBinding } from "../types.js";

export interface SourceBindingDetailProps {
  readonly binding: SourceBinding;
  /** Called when the operator dismisses the modal (Esc, backdrop,
   *  or "Close" button) AND when a successful Disable/Delete
   *  action completes — the row list refetches via `onChanged`,
   *  and the modal closes so the operator returns to the list. */
  readonly onClose: () => void;
  /** Called when the binding's enabled state changed or it was
   *  deleted. The Sources route uses this to bump its refresh
   *  nonce so the row list re-pulls. */
  readonly onChanged: () => void;
  /** @internal Test seam — defaults to globalThis.fetch via fetchAdmin. */
  readonly fetchImpl?: typeof fetch;
}

/** Modal stage. `idle` is the Q10 detail view; `disable` / `enable`
 *  / `delete` flip to confirmation panels; `edit` (PR-R2) flips to
 *  the operational-settings + credential-rotation form. */
type Stage = "idle" | "disable" | "enable" | "delete" | "edit";

// ─── PR-R2 adapter-descriptor types (mirror NewSourceBindingModal) ───────────

interface CredentialFieldDescriptor {
  readonly type: "string";
  readonly description?: string;
  readonly secret?: boolean;
}

interface PollingCredentialSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, CredentialFieldDescriptor>>;
  readonly required: readonly string[];
}

interface WebhookCredentialSchema {
  readonly type: "object";
  readonly properties: {
    readonly auth: PollingCredentialSchema;
    readonly webhook_secret: PollingCredentialSchema;
  };
  readonly required: readonly ("auth" | "webhook_secret")[];
}

type AnyCredentialSchema = PollingCredentialSchema | WebhookCredentialSchema;

interface BindingConfigField {
  readonly type: "string" | "number" | "boolean" | "array";
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly default?: string | number | boolean | readonly string[];
  readonly items?: { readonly type: "string" };
  readonly minLength?: number;
  readonly hidden?: boolean;
}

interface BindingConfigSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, BindingConfigField>>;
  readonly required: readonly string[];
}

interface AdapterDescriptor {
  readonly slug: string;
  readonly mode: "polling" | "webhook";
  readonly credentialSchema: AnyCredentialSchema;
  readonly bindingConfigSchema?: BindingConfigSchema;
}

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const FIELD_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(140px, max-content) 1fr",
  gap: "var(--space-2) var(--space-4)",
  alignItems: "baseline",
};

const LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const VALUE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
  color: "var(--fg-1)",
  margin: 0,
  wordBreak: "break-word",
};

const MONO_VALUE_STYLE: CSSProperties = {
  ...VALUE_STYLE,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
};

const URL_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  flexWrap: "wrap",
};

const URL_TEXT_STYLE: CSSProperties = {
  ...MONO_VALUE_STYLE,
  background: "var(--paper-2)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-2) var(--space-3)",
  flex: "1 1 auto",
  minWidth: 0,
  // Override break-word for the URL — UUIDs shouldn't wrap mid-segment.
  wordBreak: "break-all",
};

const COPY_FEEDBACK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  color: "var(--fg-3)",
};

const ERROR_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--alert)",
  margin: 0,
};

const ACTION_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "var(--space-3)",
  marginTop: "var(--space-3)",
};

const DESTRUCTIVE_GROUP_STYLE: CSSProperties = {
  display: "flex",
  gap: "var(--space-3)",
};

const CONFIRM_BODY_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
  lineHeight: "var(--lh-body)",
  color: "var(--fg-2)",
  margin: 0,
};

const CONFIRM_FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-3)",
};

/** PR-R2 — edit-mode chrome. */
const EDIT_SECTION_HEADING_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
  margin: 0,
  paddingTop: "var(--space-2)",
};

const EDIT_SECTION_SUBTITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  lineHeight: "var(--lh-small)",
  color: "var(--fg-3)",
  margin: 0,
};

/** Rotation banner — INFORMATIONAL (`--ink-3`). Never `--advisory`
 *  (advisory is reserved for the agent layer per design-system rules)
 *  and never `--alert` (alert is destructive only). */
const ROTATION_BANNER_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  lineHeight: "var(--lh-small)",
  color: "var(--ink-3)",
  margin: 0,
  padding: "var(--space-3) var(--space-4)",
  background: "var(--paper-2)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
};

const EDIT_FIELDS_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const EDIT_FIELD_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const EDIT_FIELD_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const EDIT_FIELD_INPUT_STYLE: CSSProperties = {
  background: "var(--paper)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-4)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
  color: "var(--fg-1)",
  width: "100%",
};

const EDIT_FIELD_INPUT_ERROR_STYLE: CSSProperties = {
  ...EDIT_FIELD_INPUT_STYLE,
  borderColor: "var(--alert)",
};

const EDIT_FIELD_DESCRIPTION_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--fg-3)",
  margin: 0,
};

const EDIT_FIELD_ERROR_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--alert)",
  margin: 0,
};

/** Style for the destructive confirm button — alert red border,
 *  ink fill (admin chrome, not advisory amber). */
const DESTRUCTIVE_CONFIRM_BTN_STYLE: CSSProperties = {
  background: "var(--alert)",
  color: "var(--paper)",
  border: "1px solid var(--alert)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-body)",
  cursor: "pointer",
};

export function SourceBindingDetail(
  props: SourceBindingDetailProps,
): JSX.Element {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">(
    "idle",
  );
  // PR-R2 edit-mode state. The descriptor is fetched on demand (the
  // first time the operator opens edit mode) and cached for the
  // lifetime of the modal.
  const [adapterDescriptor, setAdapterDescriptor] =
    useState<AdapterDescriptor | null>(null);
  const [adapterFetchError, setAdapterFetchError] = useState<string | null>(
    null,
  );
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [credentialValues, setCredentialValues] = useState<
    Record<string, string>
  >({});
  // Per-field validation errors. Keys mirror the input keys
  // (e.g. `projectGid`, `auth.personal_access_token`).
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Track whether the component is still mounted. The copy-feedback
  // flash uses a setTimeout that we don't want to setState into a
  // detached tree on rapid dismount.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const webhookOrigin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  const webhookUrl = `${webhookOrigin}/webhooks/${props.binding.id}`;

  const handleCopy = async (): Promise<void> => {
    setActionError(null);
    const clip = (
      typeof navigator !== "undefined"
        ? (navigator as Navigator & { clipboard?: { writeText?: (s: string) => Promise<void> } })
            .clipboard
        : undefined
    );
    if (clip?.writeText !== undefined) {
      try {
        await clip.writeText(webhookUrl);
        if (!mountedRef.current) return;
        setCopyState("copied");
        // 1.5s flash, then back to idle. No animation library —
        // just a state-driven re-render of the inline glyph + label.
        window.setTimeout(() => {
          if (mountedRef.current) setCopyState("idle");
        }, 1500);
      } catch {
        // Permission denied or insecure context that resolved
        // `clipboard` but rejected the call. Fall back to the
        // manual hint.
        if (mountedRef.current) setCopyState("manual");
      }
      return;
    }
    // No clipboard API at all (insecure context, locked-down
    // sandbox). Surface the manual hint — the URL itself is
    // already on screen so the operator just selects it.
    setCopyState("manual");
  };

  /** Map a thrown error from `fetchAdmin` to an operator-facing
   *  i18n string (PR-Q10b). Previously the component leaked
   *  `err.message` ("Admin API validation error (HTTP 422)") into
   *  the alert; now structured errors route through `sources.detail.errors.*`
   *  keys and the raw message never reaches the UI.
   *
   *  `defaultKey` is the fallback for unknown errors and for
   *  `ApiValidationError`s without a specific 409 mapping. */
  const mapActionError = (err: unknown, defaultKey: string): string => {
    if (err instanceof ApiAuthError) {
      return t("sources.detail.errors.auth");
    }
    if (err instanceof ApiTransientError) {
      return t("sources.detail.errors.transient");
    }
    // ApiValidationError covers 4xx other than 401/403; the 409
    // fk_restricted path is handled at the call site (DELETE only)
    // before falling back here.
    return t(defaultKey);
  };

  const submitPatch = async (enabled: boolean): Promise<void> => {
    setActionError(null);
    setSubmitting(true);
    try {
      await fetchAdmin<{ id: string; enabled: boolean }>(
        `/api/admin/source-bindings/${props.binding.id}`,
        {
          method: "PATCH",
          body: { enabled },
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      if (!mountedRef.current) return;
      props.onChanged();
      props.onClose();
    } catch (err) {
      if (!mountedRef.current) return;
      // Default to disable/enable-specific copy so the operator's
      // intent context is preserved in the surfaced message.
      const defaultKey = enabled
        ? "sources.detail.errors.enableFailed"
        : "sources.detail.errors.disableFailed";
      setActionError(mapActionError(err, defaultKey));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const submitDelete = async (): Promise<void> => {
    setActionError(null);
    setSubmitting(true);
    try {
      await fetchAdmin<{ deleted: true }>(
        `/api/admin/source-bindings/${props.binding.id}`,
        {
          method: "DELETE",
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      if (!mountedRef.current) return;
      props.onChanged();
      props.onClose();
    } catch (err) {
      if (!mountedRef.current) return;
      // The DELETE endpoint returns 409 when an append-only audit
      // FK blocks the cascade. Surface a more specific copy so the
      // operator picks "disable" instead. Everything else routes
      // through the structured-error i18n mapper.
      if (err instanceof ApiValidationError && err.status === 409) {
        setActionError(t("sources.detail.errors.deleteFkRestricted"));
      } else {
        setActionError(
          mapActionError(err, "sources.detail.errors.deleteFailed"),
        );
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const onIdle = (): void => {
    setStage("idle");
    setActionError(null);
    setFieldErrors({});
  };

  // ─── PR-R2: edit-mode helpers ────────────────────────────────────────────

  /** Open the edit panel. The first call lazy-loads the adapter
   *  descriptor so we know which form fields to render. */
  const openEdit = async (): Promise<void> => {
    setActionError(null);
    setFieldErrors({});
    setStage("edit");
    if (adapterDescriptor !== null) return;
    try {
      const resp = await fetchAdmin<{
        adapters: readonly AdapterDescriptor[];
      }>("/api/admin/adapters", fetchOptsFor(props.fetchImpl));
      const found = resp.adapters.find(
        (a) => a.slug === props.binding.adapterSlug,
      );
      if (!mountedRef.current) return;
      if (found === undefined) {
        setAdapterFetchError(t("sourceBindingDetail.edit.errors.transient"));
        return;
      }
      setAdapterDescriptor(found);
      // Pre-seed the config form. Priority: binding's persisted
      // config value → schema default. If the binding row carries
      // `config` (admin-API GET surfaces it as of PR-R2), prefer
      // those values so the operator edits on top of reality —
      // unchanged fields will be re-sent on Save and the route's
      // jsonb-replace semantics preserve them.
      const persisted = props.binding.config ?? {};
      const seeded: Record<string, string> = {};
      const schema = found.bindingConfigSchema;
      if (schema !== undefined) {
        for (const [key, field] of Object.entries(schema.properties)) {
          if (field.hidden === true) continue;
          const persistedValue = persisted[key];
          if (persistedValue !== undefined) {
            seeded[key] = coercePersistedToRaw(field, persistedValue);
            continue;
          }
          const def = defaultAsRaw(field);
          if (def !== undefined) seeded[key] = def;
        }
      }
      setConfigValues(seeded);
    } catch (err) {
      if (!mountedRef.current) return;
      setAdapterFetchError(
        err instanceof Error
          ? mapActionError(err, "sourceBindingDetail.edit.errors.transient")
          : t("sourceBindingDetail.edit.errors.transient"),
      );
    }
  };

  const initialConfigSeed = useMemo<Record<string, string>>(() => {
    if (adapterDescriptor === null) return {};
    const out: Record<string, string> = {};
    const schema = adapterDescriptor.bindingConfigSchema;
    if (schema === undefined) return out;
    const persisted = props.binding.config ?? {};
    for (const [key, field] of Object.entries(schema.properties)) {
      if (field.hidden === true) continue;
      const persistedValue = persisted[key];
      if (persistedValue !== undefined) {
        out[key] = coercePersistedToRaw(field, persistedValue);
        continue;
      }
      const def = defaultAsRaw(field);
      if (def !== undefined) out[key] = def;
    }
    return out;
    // The binding's persisted config is the seed; identity stable.
  }, [adapterDescriptor, props.binding.config]);

  /** Compute whether the operator has touched the config section. */
  const configChanged = useMemo<boolean>(() => {
    const keys = new Set([
      ...Object.keys(initialConfigSeed),
      ...Object.keys(configValues),
    ]);
    for (const k of keys) {
      if ((configValues[k] ?? "") !== (initialConfigSeed[k] ?? "")) {
        return true;
      }
    }
    return false;
  }, [configValues, initialConfigSeed]);

  /** Compute whether the operator has filled any credential field.
   *  Rotation is atomic — if ANY field is non-empty we treat it as
   *  a rotation intent and require ALL required fields. */
  const credentialsChanged = useMemo<boolean>(() => {
    return Object.values(credentialValues).some((v) => v.length > 0);
  }, [credentialValues]);

  /** Build the `config` body the route accepts. The route's UPDATE
   *  is a full jsonb REPLACE, so we emit the COMPLETE current state
   *  (operator edits + seeded defaults / persisted unchanged values).
   *  Anything the binding-list endpoint surfaced via `binding.config`
   *  was already pre-seeded into `configValues` on `openEdit()`, so
   *  this is just a coerce-to-schema-shape pass.
   *
   *  Coerces string-keyed input values into the schema-declared
   *  shape (boolean / number / array). Fields the operator cleared
   *  (current.length === 0) are omitted so a blanked input doesn't
   *  collapse to `""` in jsonb — adapter Zod schemas reject empty
   *  strings on required fields. */
  const buildConfigBody = (): Record<string, unknown> => {
    if (adapterDescriptor === null) return {};
    const schema = adapterDescriptor.bindingConfigSchema;
    if (schema === undefined) return {};
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema.properties)) {
      if (field.hidden === true) continue;
      const current = configValues[key] ?? defaultAsRaw(field);
      if (current === undefined) continue;
      if (current.length === 0) continue;
      if (field.type === "boolean") {
        out[key] = current === "true";
      } else if (field.type === "number") {
        const n = Number(current);
        if (Number.isFinite(n)) out[key] = n;
      } else if (field.type === "array") {
        const items = current
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (items.length > 0) out[key] = items;
      } else {
        out[key] = current;
      }
    }
    return out;
  };

  /** Build the `credentials` body. Polling adapters → flat object;
   *  webhook adapters → `{auth: {...}, webhook_secret: {...}}`. */
  const buildCredentialsBody = (): Record<string, unknown> => {
    if (adapterDescriptor === null) return {};
    if (adapterDescriptor.mode === "polling") {
      const out: Record<string, string> = {};
      const schema = adapterDescriptor.credentialSchema as PollingCredentialSchema;
      for (const k of Object.keys(schema.properties)) {
        out[k] = credentialValues[k] ?? "";
      }
      return out;
    }
    const webhook = adapterDescriptor.credentialSchema as WebhookCredentialSchema;
    const auth: Record<string, string> = {};
    for (const k of Object.keys(webhook.properties.auth.properties)) {
      auth[k] = credentialValues[`auth.${k}`] ?? "";
    }
    const webhookSecret: Record<string, string> = {};
    for (const k of Object.keys(webhook.properties.webhook_secret.properties)) {
      webhookSecret[k] = credentialValues[`webhook_secret.${k}`] ?? "";
    }
    return { auth, webhook_secret: webhookSecret };
  };

  /** Map a 422 validation response into per-field errors keyed by the
   *  same input keys the form uses. The route's 422 payload includes
   *  a `missing: string[]` of dot-prefixed paths (e.g.
   *  `auth.personal_access_token` for credentials, plain key names for
   *  config), so we can plug each path straight into the inline-error
   *  state without remapping. */
  const apply422FieldErrors = (
    err: unknown,
    fallbackI18nKey: string,
  ): void => {
    if (err instanceof ApiValidationError && err.status === 422) {
      const body = err.body as { missing?: unknown } | undefined;
      const missing = Array.isArray(body?.missing)
        ? (body!.missing as unknown[]).filter(
            (m): m is string => typeof m === "string",
          )
        : [];
      if (missing.length > 0) {
        const fe: Record<string, string> = { ...fieldErrors };
        for (const path of missing) {
          fe[path] = t("sources.create.errors.requiredField");
        }
        setFieldErrors(fe);
        setActionError(t(fallbackI18nKey));
        return;
      }
    }
    if (err instanceof ApiAuthError) {
      setActionError(t("sourceBindingDetail.edit.errors.auth"));
      return;
    }
    if (err instanceof ApiTransientError) {
      setActionError(t("sourceBindingDetail.edit.errors.transient"));
      return;
    }
    setActionError(t(fallbackI18nKey));
  };

  const submitEdit = async (): Promise<void> => {
    setActionError(null);
    setFieldErrors({});
    setSubmitting(true);
    let configOk = true;
    try {
      // Send config first, then credentials, when both changed —
      // the discriminator on the route rejects mixed bodies, so
      // this is two sequential PATCHes (one verb per audit row).
      if (configChanged) {
        try {
          await fetchAdmin<{ id: string }>(
            `/api/admin/source-bindings/${props.binding.id}`,
            {
              method: "PATCH",
              body: { config: buildConfigBody() },
              ...fetchOptsFor(props.fetchImpl),
            },
          );
          if (!mountedRef.current) return;
          props.onChanged();
        } catch (err) {
          if (!mountedRef.current) return;
          configOk = false;
          apply422FieldErrors(
            err,
            "sourceBindingDetail.edit.errors.configFailed",
          );
        }
      }
      if (configOk && credentialsChanged) {
        try {
          await fetchAdmin<{ id: string; credentialsRotatedAt: string }>(
            `/api/admin/source-bindings/${props.binding.id}`,
            {
              method: "PATCH",
              body: { credentials: buildCredentialsBody() },
              ...fetchOptsFor(props.fetchImpl),
            },
          );
          if (!mountedRef.current) return;
          props.onChanged();
        } catch (err) {
          if (!mountedRef.current) return;
          apply422FieldErrors(
            err,
            "sourceBindingDetail.edit.errors.credentialsFailed",
          );
          return;
        }
      }
      // Only return to view mode if no errors landed.
      if (mountedRef.current && configOk) {
        // Surface success by returning to idle; the parent's
        // refresh nonce already bumped via onChanged().
        setStage("idle");
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const renderConfirm = (
    title: string,
    body: string,
    confirmLabel: string,
    onConfirm: () => void,
    destructive: boolean,
  ): JSX.Element => (
    <div style={SECTION_STYLE}>
      <h3 style={{ ...VALUE_STYLE, fontWeight: 500 }}>{title}</h3>
      <p style={CONFIRM_BODY_STYLE}>{body}</p>
      {actionError !== null ? (
        <p style={ERROR_TEXT_STYLE} role="alert">
          {actionError}
        </p>
      ) : null}
      <div style={CONFIRM_FOOTER_STYLE}>
        <Btn variant="ghost" onClick={onIdle} disabled={submitting}>
          {t("sources.detail.actions.cancel")}
        </Btn>
        <button
          type="button"
          disabled={submitting}
          onClick={onConfirm}
          style={
            destructive
              ? DESTRUCTIVE_CONFIRM_BTN_STYLE
              : {
                  ...DESTRUCTIVE_CONFIRM_BTN_STYLE,
                  background: "var(--ink)",
                  borderColor: "var(--ink)",
                }
          }
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );

  if (stage === "disable") {
    return (
      <Modal
        title={t("sources.detail.actions.confirmDisableTitle")}
        onClose={props.onClose}
        maxWidth={520}
      >
        {renderConfirm(
          t("sources.detail.actions.confirmDisableTitle"),
          t("sources.detail.actions.confirmDisableBody"),
          t("sources.detail.actions.confirmDisable"),
          () => {
            void submitPatch(false);
          },
          false,
        )}
      </Modal>
    );
  }
  if (stage === "enable") {
    return (
      <Modal
        title={t("sources.detail.actions.confirmEnableTitle")}
        onClose={props.onClose}
        maxWidth={520}
      >
        {renderConfirm(
          t("sources.detail.actions.confirmEnableTitle"),
          t("sources.detail.actions.confirmEnableBody"),
          t("sources.detail.actions.confirmEnable"),
          () => {
            void submitPatch(true);
          },
          false,
        )}
      </Modal>
    );
  }
  if (stage === "delete") {
    return (
      <Modal
        title={t("sources.detail.actions.confirmDeleteTitle")}
        onClose={props.onClose}
        maxWidth={560}
      >
        {renderConfirm(
          t("sources.detail.actions.confirmDeleteTitle"),
          t("sources.detail.actions.confirmDeleteBody"),
          t("sources.detail.actions.confirmDelete"),
          () => {
            void submitDelete();
          },
          true,
        )}
      </Modal>
    );
  }
  if (stage === "edit") {
    return (
      <Modal
        title={t("sourceBindingDetail.edit.title")}
        subtitle={t("sourceBindingDetail.edit.subtitle")}
        onClose={props.onClose}
        maxWidth={620}
      >
        <div style={SECTION_STYLE}>
          {/* Operational settings section. */}
          <div style={EDIT_FIELDS_STYLE}>
            <h3 style={EDIT_SECTION_HEADING_STYLE}>
              {t("sourceBindingDetail.edit.config.title")}
            </h3>
            <p style={EDIT_SECTION_SUBTITLE_STYLE}>
              {t("sourceBindingDetail.edit.config.subtitle")}
            </p>
            {adapterDescriptor === null ? (
              adapterFetchError !== null ? (
                <p style={ERROR_TEXT_STYLE} role="alert">
                  {adapterFetchError}
                </p>
              ) : null
            ) : adapterDescriptor.bindingConfigSchema === undefined ? null : (
              <>
                {Object.entries(
                  adapterDescriptor.bindingConfigSchema.properties,
                ).map(([key, field]) => {
                  if (field.hidden === true) return null;
                  return (
                    <EditField
                      key={key}
                      testId={`edit-config-${key}`}
                      label={key}
                      {...(field.description !== undefined
                        ? { description: field.description }
                        : {})}
                      value={configValues[key] ?? ""}
                      onChange={(v): void => {
                        setConfigValues((cur) => ({ ...cur, [key]: v }));
                        if (fieldErrors[key] !== undefined) {
                          setFieldErrors((prev) => {
                            const next = { ...prev };
                            delete next[key];
                            return next;
                          });
                        }
                      }}
                      {...(fieldErrors[key] !== undefined
                        ? { error: fieldErrors[key] as string }
                        : {})}
                    />
                  );
                })}
              </>
            )}
          </div>

          {/* Rotate credentials section. */}
          <div style={EDIT_FIELDS_STYLE}>
            <h3 style={EDIT_SECTION_HEADING_STYLE}>
              {t("sourceBindingDetail.edit.credentials.title")}
            </h3>
            <p style={EDIT_SECTION_SUBTITLE_STYLE}>
              {t("sourceBindingDetail.edit.credentials.subtitle")}
            </p>
            <p
              style={ROTATION_BANNER_STYLE}
              data-testid="rotation-banner"
            >
              {t("sourceBindingDetail.edit.credentials.banner")}
            </p>
            {adapterDescriptor === null
              ? null
              : renderCredentialFields({
                  descriptor: adapterDescriptor,
                  values: credentialValues,
                  errors: fieldErrors,
                  onChange: (key, v): void => {
                    setCredentialValues((cur) => ({ ...cur, [key]: v }));
                    if (fieldErrors[key] !== undefined) {
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next[key];
                        return next;
                      });
                    }
                  },
                })}
          </div>

          {actionError !== null ? (
            <p style={ERROR_TEXT_STYLE} role="alert">
              {actionError}
            </p>
          ) : null}

          <div style={CONFIRM_FOOTER_STYLE}>
            <Btn variant="ghost" onClick={onIdle} disabled={submitting}>
              {t("sourceBindingDetail.edit.cancel")}
            </Btn>
            <button
              type="button"
              disabled={submitting}
              onClick={(): void => {
                void submitEdit();
              }}
              style={{
                ...DESTRUCTIVE_CONFIRM_BTN_STYLE,
                background: submitting ? "var(--ink-3)" : "var(--ink)",
                borderColor: submitting ? "var(--ink-3)" : "var(--ink)",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              {submitting
                ? t("sourceBindingDetail.edit.saving")
                : t("sourceBindingDetail.edit.save")}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  const pendingCount = props.binding.pendingEventsCount ?? 0;
  const sigFailCount = props.binding.sigFailCount24h ?? 0;

  return (
    <Modal
      title={t("sources.detail.title")}
      subtitle={t("sources.detail.subtitle")}
      onClose={props.onClose}
      maxWidth={620}
    >
      <div style={SECTION_STYLE}>
        {/* Webhook URL — the load-bearing piece of this modal. */}
        <div style={SECTION_STYLE}>
          <span style={LABEL_STYLE}>{t("sources.detail.labels.webhookUrl")}</span>
          <div style={URL_ROW_STYLE}>
            <code style={URL_TEXT_STYLE} data-webhook-url>
              {webhookUrl}
            </code>
            <Btn variant="subtle" onClick={(): void => { void handleCopy(); }}>
              {copyState === "copied"
                ? t("sources.detail.copy.copied")
                : t("sources.detail.copy.copy")}
            </Btn>
          </div>
          {copyState === "copied" ? (
            <span style={COPY_FEEDBACK_STYLE} role="status">
              <GlyphFilledDisc
                size={10}
                title="copied"
                style={{ color: "var(--healthy)" }}
              />
              {t("sources.detail.copy.copied")}
            </span>
          ) : null}
          {copyState === "manual" ? (
            <span style={COPY_FEEDBACK_STYLE} role="status">
              {t("sources.detail.copy.manualHint")}
            </span>
          ) : null}
        </div>

        {/* Field grid — adapter / domain / mode / counts. */}
        <div style={FIELD_GRID_STYLE}>
          <span style={LABEL_STYLE}>{t("sources.detail.labels.bindingId")}</span>
          <span style={MONO_VALUE_STYLE}>{props.binding.id}</span>

          <span style={LABEL_STYLE}>{t("sources.detail.labels.adapter")}</span>
          <span style={VALUE_STYLE}>{props.binding.adapterSlug}</span>

          <span style={LABEL_STYLE}>{t("sources.detail.labels.domain")}</span>
          <span style={VALUE_STYLE}>{props.binding.domainSlug}</span>

          <span style={LABEL_STYLE}>{t("sources.detail.labels.reviewMode")}</span>
          <span style={VALUE_STYLE}>{props.binding.reviewMode}</span>

          <span style={LABEL_STYLE}>{t("sources.detail.labels.enabled")}</span>
          <span style={VALUE_STYLE}>
            {props.binding.enabled ? t("common.yes") : t("common.no")}
          </span>

          <span style={LABEL_STYLE}>
            {t("sources.detail.labels.pendingEvents")}
          </span>
          <span style={MONO_VALUE_STYLE}>{pendingCount}</span>

          <span style={LABEL_STYLE}>
            {t("sources.detail.labels.sigFailures")}
          </span>
          <span style={MONO_VALUE_STYLE}>{sigFailCount}</span>

          <span style={LABEL_STYLE}>{t("sources.detail.labels.lastError")}</span>
          <span style={VALUE_STYLE}>
            {props.binding.lastError ?? t("sources.detail.labels.noLastError")}
          </span>
        </div>

        {actionError !== null ? (
          <p style={ERROR_TEXT_STYLE} role="alert">
            {actionError}
          </p>
        ) : null}

        <div style={ACTION_ROW_STYLE}>
          <Btn variant="ghost" onClick={props.onClose}>
            {t("sources.detail.actions.close")}
          </Btn>
          <div style={DESTRUCTIVE_GROUP_STYLE}>
            <Btn
              variant="subtle"
              onClick={(): void => {
                void openEdit();
              }}
            >
              {t("sourceBindingDetail.edit.open")}
            </Btn>
            <Btn
              variant="subtle"
              onClick={(): void =>
                setStage(props.binding.enabled ? "disable" : "enable")
              }
            >
              {props.binding.enabled
                ? t("sources.detail.actions.disable")
                : t("sources.detail.actions.enable")}
            </Btn>
            <Btn variant="ghost" onClick={(): void => setStage("delete")}>
              {t("sources.detail.actions.delete")}
            </Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Render an editable text input + helper + per-field error. The
 *  input id mirrors the field key so both `data-testid` queries
 *  and accessible label-for relationships work. */
interface EditFieldProps {
  readonly testId: string;
  readonly label: string;
  readonly description?: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly error?: string;
  readonly secret?: boolean;
}

function EditField(props: EditFieldProps): JSX.Element {
  const inputStyle =
    props.error !== undefined
      ? EDIT_FIELD_INPUT_ERROR_STYLE
      : EDIT_FIELD_INPUT_STYLE;
  return (
    <div style={EDIT_FIELD_ROW_STYLE}>
      <label
        htmlFor={props.testId}
        style={EDIT_FIELD_LABEL_STYLE}
      >
        {props.label}
      </label>
      {props.description !== undefined ? (
        <p style={EDIT_FIELD_DESCRIPTION_STYLE}>{props.description}</p>
      ) : null}
      <input
        id={props.testId}
        data-testid={props.testId}
        type={props.secret === true ? "password" : "text"}
        autoComplete={props.secret === true ? "new-password" : "off"}
        style={inputStyle}
        value={props.value}
        onChange={(e): void => props.onChange(e.target.value)}
      />
      {props.error !== undefined ? (
        <p
          style={EDIT_FIELD_ERROR_STYLE}
          data-testid={`${props.testId}-error`}
          role="alert"
        >
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/** Coerce a persisted-config value (anything jsonb gives us) into
 *  the same string form `configValues` uses for the input element.
 *  Schema decides the input shape; runtime values may be of any
 *  matching type. Falls back to `String(v)` for unknown shapes
 *  rather than throwing — the field renders empty input would be a
 *  worse UX than showing the literal. */
function coercePersistedToRaw(
  field: BindingConfigField,
  value: unknown,
): string {
  if (value === null) return "";
  if (field.type === "boolean") {
    if (typeof value === "boolean") return value ? "true" : "false";
    return String(value);
  }
  if (field.type === "number") {
    if (typeof value === "number") return String(value);
    return String(value);
  }
  if (field.type === "array") {
    if (Array.isArray(value)) {
      return value
        .filter((v): v is string => typeof v === "string")
        .join(", ");
    }
    return String(value);
  }
  // string (with or without enum).
  if (typeof value === "string") return value;
  return String(value);
}

/** Coerce a schema-declared default into the same string form
 *  `configValues` uses (booleans → "true"/"false"; numbers →
 *  String(n); arrays → CSV). Mirrors the helper in
 *  NewSourceBindingModal. */
function defaultAsRaw(field: BindingConfigField): string | undefined {
  if (field.default === undefined) return undefined;
  if (typeof field.default === "boolean") return field.default ? "true" : "false";
  if (typeof field.default === "number") return String(field.default);
  if (typeof field.default === "string") return field.default;
  return field.default.join(", ");
}

/** Render the credential rotation form. Polling adapters → flat
 *  fields; webhook adapters → two grouped sections (auth +
 *  webhook_secret). All inputs render empty — we never read the
 *  existing plaintext (rotation is atomic; partial updates aren't
 *  supported in v0.1). */
interface RenderCredentialFieldsArgs {
  readonly descriptor: AdapterDescriptor;
  readonly values: Record<string, string>;
  readonly errors: Record<string, string>;
  readonly onChange: (key: string, value: string) => void;
}

function renderCredentialFields(
  args: RenderCredentialFieldsArgs,
): JSX.Element {
  const { descriptor, values, errors, onChange } = args;
  if (descriptor.mode === "polling") {
    const schema = descriptor.credentialSchema as PollingCredentialSchema;
    return (
      <>
        {Object.entries(schema.properties).map(([key, prop]) => (
          <EditField
            key={key}
            testId={`edit-cred-${key}`}
            label={key}
            {...(prop.description !== undefined
              ? { description: prop.description }
              : {})}
            value={values[key] ?? ""}
            onChange={(v): void => onChange(key, v)}
            {...(errors[key] !== undefined
              ? { error: errors[key] as string }
              : {})}
            secret={prop.secret === true}
          />
        ))}
      </>
    );
  }
  const webhook = descriptor.credentialSchema as WebhookCredentialSchema;
  return (
    <>
      {Object.entries(webhook.properties.auth.properties).map(([key, prop]) => {
        const fullKey = `auth.${key}`;
        return (
          <EditField
            key={fullKey}
            testId={`edit-cred-${fullKey}`}
            label={fullKey}
            {...(prop.description !== undefined
              ? { description: prop.description }
              : {})}
            value={values[fullKey] ?? ""}
            onChange={(v): void => onChange(fullKey, v)}
            {...(errors[fullKey] !== undefined
              ? { error: errors[fullKey] as string }
              : {})}
            secret={prop.secret === true}
          />
        );
      })}
      {Object.entries(webhook.properties.webhook_secret.properties).map(
        ([key, prop]) => {
          const fullKey = `webhook_secret.${key}`;
          return (
            <EditField
              key={fullKey}
              testId={`edit-cred-${fullKey}`}
              label={fullKey}
              {...(prop.description !== undefined
                ? { description: prop.description }
                : {})}
              value={values[fullKey] ?? ""}
              onChange={(v): void => onChange(fullKey, v)}
              {...(errors[fullKey] !== undefined
                ? { error: errors[fullKey] as string }
                : {})}
              secret={prop.secret === true}
            />
          );
        },
      )}
    </>
  );
}
