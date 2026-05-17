/**
 * NewAgentInstanceModal — `+ New agent instance` flow on the
 * Agents tab (PR-W4-UI, phase-a appendix #15).
 *
 * POSTs to /api/admin/agent-instances; on success calls the
 * parent's onCreated so the list refetches.
 *
 * Input pattern (wave-12 PR-Z9 / G12):
 *   The NAME input is UNCONTROLLED — React does not own
 *   `value`. The DOM is the source of truth and we read it via
 *   `useRef<HTMLInputElement>` on submit. Survives external
 *   native-value-setter bypasses (1Password / Bitwarden /
 *   programmatic JS-set) that previously swapped controlled-
 *   input state between fields on the next React render.
 *   Validation state still lives in React so inline errors +
 *   `aria-invalid` can re-render; it's recomputed on submit,
 *   not on each keystroke.
 *
 * Inline error mapping:
 *   - 409 `name_collision`   → name field
 *   - 422 `unknown_scope_domain_ids`   → scope field
 *   - 422 `duplicate_scope_domain_ids` → scope field (defensive;
 *     the UI dedupes via Set semantics in
 *     MultiSelectDomains.toggle, so this is only reachable
 *     under a programmatic prop-injection.)
 *   - 422 `invalid_cron` → schedule_cron field
 *   - any other 4xx/5xx → generic form error row
 *
 * Hard-nos honored: lowercase `opencoo`, primary CTA
 * ink-on-paper, no advisory amber on admin chrome, no
 * gradients, no emoji, no drop shadows for elevation.
 */
import { useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Field } from "./Field.js";
import { Modal } from "./Modal.js";
import { MultiSelectDomains } from "./MultiSelectDomains.js";
import { ApiValidationError, fetchAdmin, fetchOptsFor } from "../lib/api.js";

/** Mirrors `packages/shared/agent-definitions` — kept inline here
 *  rather than imported because the UI ships standalone and the
 *  set is short + stable. A new definition (e.g. SkillMiner
 *  ships in phase-b) gets added here in the same PR that ships
 *  its definition registration. */
const DEFINITION_SLUGS = [
  "heartbeat",
  "lint",
  "chat",
  "surfacer",
  "builder",
  "classifier",
  "compiler",
  "worldview-domain",
  "worldview-company",
] as const;

type DefinitionSlug = (typeof DEFINITION_SLUGS)[number];

const LOCALES = ["en", "pl", "auto"] as const;
type Locale = (typeof LOCALES)[number];

/** Created-instance shape returned by the server's 201. The
 *  parent uses it to refresh its row list without a re-fetch. */
export interface CreatedAgentInstance {
  readonly id: string;
  readonly definitionSlug: string;
  readonly name: string;
  readonly scopeDomainIds: ReadonlyArray<string>;
  readonly outputChannelIds: ReadonlyArray<{
    readonly adapter_slug: string;
    readonly config: Record<string, unknown>;
  }>;
  readonly scheduleCron: string | null;
  readonly locale: string;
  readonly enabled: boolean;
}

export interface NewAgentInstanceModalProps {
  readonly onCreated: (created: CreatedAgentInstance) => void;
  readonly onClose: () => void;
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-3)",
};

const FIELDS_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--ink-3)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const SELECT_STYLE: CSSProperties = {
  background: "var(--paper)",
  color: "var(--ink)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "8px 10px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
};

const HELPER_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--ink-3)",
  letterSpacing: "0.04em",
  margin: 0,
};

const INLINE_ERROR_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--alert)",
  letterSpacing: "0.04em",
  margin: 0,
};

const CHECKBOX_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--ink-2)",
};

export function NewAgentInstanceModal(
  props: NewAgentInstanceModalProps,
): JSX.Element {
  const { t } = useTranslation();
  const nameRef = useRef<HTMLInputElement>(null);
  const scheduleRef = useRef<HTMLInputElement>(null);

  const [definitionSlug, setDefinitionSlug] =
    useState<DefinitionSlug>("heartbeat");
  const [locale, setLocale] = useState<Locale>("en");
  const [enabled, setEnabled] = useState<boolean>(true);
  const [scopeDomainIds, setScopeDomainIds] = useState<ReadonlyArray<string>>(
    [],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const validate = (
    name: string,
    scope: ReadonlyArray<string>,
  ): Record<string, string> => {
    const next: Record<string, string> = {};
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      next["name"] = t("agentInstance.create.errors.nameRequired");
    } else if (trimmedName.length > 100) {
      next["name"] = t("agentInstance.create.errors.nameTooLong");
    }
    if (scope.length === 0) {
      next["scope_domain_ids"] = t(
        "agentInstance.create.errors.scopeRequired",
      );
    } else if (scope.length > 20) {
      next["scope_domain_ids"] = t(
        "agentInstance.create.errors.scopeTooMany",
      );
    }
    return next;
  };

  const submit = async (): Promise<void> => {
    const name = nameRef.current?.value ?? "";
    const scheduleCronRaw = scheduleRef.current?.value ?? "";
    const scheduleCron = scheduleCronRaw.trim();

    const validation = validate(name, scopeDomainIds);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      return;
    }
    setErrors({});
    setSubmitting(true);

    const body: Record<string, unknown> = {
      definition_slug: definitionSlug,
      name: name.trim(),
      scope_domain_ids: scopeDomainIds,
      locale,
      enabled,
    };
    // Send schedule_cron only when the operator typed something.
    // The server defaults schedule_cron to null when absent.
    if (scheduleCron.length > 0) body["schedule_cron"] = scheduleCron;

    try {
      const result = await fetchAdmin<CreatedAgentInstance>(
        "/api/admin/agent-instances",
        {
          method: "POST",
          body,
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      props.onCreated(result);
    } catch (err) {
      if (err instanceof ApiValidationError) {
        const errBody = err.body as
          | { error?: string; missing?: ReadonlyArray<string> }
          | undefined;
        const code = errBody?.error;
        if (err.status === 409 && code === "name_collision") {
          setErrors({
            name: t("agentInstance.create.errors.nameCollision"),
          });
          return;
        }
        if (err.status === 422 && code === "unknown_scope_domain_ids") {
          const missing = errBody?.missing ?? [];
          setErrors({
            scope_domain_ids: t(
              "agentInstance.create.errors.unknownScopeDomainIds",
              { ids: missing.join(", ") },
            ),
          });
          return;
        }
        if (err.status === 422 && code === "duplicate_scope_domain_ids") {
          setErrors({
            scope_domain_ids: t(
              "agentInstance.create.errors.duplicateScopeDomainIds",
            ),
          });
          return;
        }
        if (err.status === 422 && code === "invalid_cron") {
          setErrors({
            schedule_cron: t("agentInstance.create.errors.invalidCron"),
          });
          return;
        }
      }
      setErrors({ form: t("agentInstance.create.errors.generic") });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={t("agentInstance.create.title")}
      subtitle={t("agentInstance.create.subtitle")}
      onClose={props.onClose}
      maxWidth={580}
      actions={
        <div style={FOOTER_STYLE}>
          <Btn variant="ghost" onClick={props.onClose} disabled={submitting}>
            {t("common.cancel")}
          </Btn>
          <Btn
            variant="primary"
            disabled={submitting}
            onClick={(): void => {
              void submit();
            }}
          >
            {submitting
              ? t("agentInstance.create.submitting")
              : t("agentInstance.create.submit")}
          </Btn>
        </div>
      }
    >
      <div style={FIELDS_STYLE}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LABEL_STYLE}>
            {t("agentInstance.create.fields.definitionSlug")}
          </span>
          <select
            name="definition_slug"
            value={definitionSlug}
            disabled={submitting}
            onChange={(e): void => {
              const v = e.target.value;
              if ((DEFINITION_SLUGS as ReadonlyArray<string>).includes(v)) {
                setDefinitionSlug(v as DefinitionSlug);
              }
            }}
            style={SELECT_STYLE}
          >
            {DEFINITION_SLUGS.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        </label>

        <Field
          name="name"
          label={t("agentInstance.create.fields.name")}
          inputRef={nameRef}
          defaultValue=""
          required
          mono
          helper={t("agentInstance.create.help.name")}
          {...(errors["name"] !== undefined ? { error: errors["name"] } : {})}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LABEL_STYLE}>
            {t("agentInstance.create.fields.scopeDomainIds")}
            <span style={{ color: "var(--alert)" }} aria-hidden="true">
              {" "}
              *
            </span>
          </span>
          <MultiSelectDomains
            selectedIds={scopeDomainIds}
            onChange={setScopeDomainIds}
            disabled={submitting}
            {...(props.fetchImpl !== undefined
              ? { fetchImpl: props.fetchImpl }
              : {})}
          />
          <p style={HELPER_STYLE}>{t("agentInstance.create.help.scope")}</p>
          {errors["scope_domain_ids"] !== undefined ? (
            <p style={INLINE_ERROR_STYLE} role="alert">
              {errors["scope_domain_ids"]}
            </p>
          ) : null}
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LABEL_STYLE}>
            {t("agentInstance.create.fields.locale")}
          </span>
          <select
            name="locale"
            value={locale}
            disabled={submitting}
            onChange={(e): void => {
              const v = e.target.value;
              if ((LOCALES as ReadonlyArray<string>).includes(v)) {
                setLocale(v as Locale);
              }
            }}
            style={SELECT_STYLE}
          >
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>

        <Field
          name="schedule_cron"
          label={t("agentInstance.create.fields.scheduleCron")}
          inputRef={scheduleRef}
          defaultValue=""
          mono
          helper={t("agentInstance.create.help.scheduleCron")}
          {...(errors["schedule_cron"] !== undefined
            ? { error: errors["schedule_cron"] }
            : {})}
        />

        <label style={CHECKBOX_ROW_STYLE}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={submitting}
            onChange={(e): void => setEnabled(e.target.checked)}
          />
          {t("agentInstance.create.fields.enabled")}
        </label>

        {errors["form"] !== undefined ? (
          <p style={INLINE_ERROR_STYLE} role="alert">
            {errors["form"]}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
