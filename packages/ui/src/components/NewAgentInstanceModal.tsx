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
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import cronParser from "cron-parser";

import { Btn } from "./Btn.js";
import { Field } from "./Field.js";
import { Modal } from "./Modal.js";
import { MultiSelectDomains } from "./MultiSelectDomains.js";
import { TooltipTrigger } from "./Tooltip.js";
import { ApiValidationError, fetchAdmin, fetchOptsFor } from "../lib/api.js";
import { useLiveValidation } from "../hooks/useLiveValidation.js";

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
  // PR-B4: shadow-state mirrors for the uncontrolled name + cron
  // inputs so useLiveValidation can observe operator keystrokes
  // (and external-setter dispatches). The DOM remains SoT on
  // submit; this state only feeds the live-validation hook.
  const [liveValues, setLiveValues] = useState<{
    readonly name: string;
    readonly schedule_cron: string;
  }>({ name: "", schedule_cron: "" });
  // PR-B4 (Copilot triage): cache the known domain-id set so the
  // scope-domain-ids async validator doesn't re-GET `/api/admin/
  // domains` on every selection toggle. Fetched once per modal
  // session; the server's submit-time `unknown_scope_domain_ids`
  // 422 still catches any race between cache load and submit.
  const domainIdCacheRef = useRef<ReadonlySet<string> | null>(null);
  const domainIdCacheLoadingRef = useRef<Promise<ReadonlySet<string>> | null>(
    null,
  );

  // Subscribe to native `input` events on the uncontrolled inputs.
  // Mirrors the Z9 pattern in NewDomainModal — external-setter
  // bypasses (1Password / Bitwarden) reach the validation hook the
  // same way real keystrokes do.
  useEffect(() => {
    const nameEl = nameRef.current;
    const scheduleEl = scheduleRef.current;
    if (nameEl === null || scheduleEl === null) return;
    const onNameInput = (): void => {
      setLiveValues((cur) =>
        cur.name === nameEl.value ? cur : { ...cur, name: nameEl.value },
      );
    };
    const onScheduleInput = (): void => {
      setLiveValues((cur) =>
        cur.schedule_cron === scheduleEl.value
          ? cur
          : { ...cur, schedule_cron: scheduleEl.value },
      );
    };
    nameEl.addEventListener("input", onNameInput);
    scheduleEl.addEventListener("input", onScheduleInput);
    return (): void => {
      nameEl.removeEventListener("input", onNameInput);
      scheduleEl.removeEventListener("input", onScheduleInput);
    };
  }, []);

  // PR-B4: live validation. `definition_slug` is a controlled
  // select with a closed enum → sync check matches enum.
  // `name` is uncontrolled and mirrored via liveValues; sync
  // length 1-100. `schedule_cron` (optional) parses via cron-parser
  // when non-empty. `scope_domain_ids` async-validates against the
  // server's domains list — picks must reference existing rows.
  const validation = useLiveValidation<{
    readonly name: string;
    readonly schedule_cron: string;
    readonly definition_slug: string;
    readonly scope_domain_ids: string;
  }>(
    {
      name: liveValues.name,
      schedule_cron: liveValues.schedule_cron,
      definition_slug: definitionSlug,
      scope_domain_ids: scopeDomainIds.join(","),
    },
    {
      name: (v: string): string | null => {
        // Empty input stays idle (operator hasn't typed yet) — the
        // submit-time `nameRequired` gate still fires.
        if (v.length === 0) return null;
        const trimmed = v.trim();
        // Pure whitespace flags `nameRequired` as soon as it's typed
        // (the operator clearly meant to enter a name).
        if (trimmed.length === 0) {
          return t("agentInstance.create.errors.nameRequired");
        }
        if (trimmed.length > 100) {
          return t("agentInstance.create.errors.nameTooLong");
        }
        return null;
      },
      schedule_cron: (v: string): string | null => {
        if (v.trim().length === 0) return null;
        try {
          cronParser.parseExpression(v.trim(), { tz: "UTC" });
          return null;
        } catch {
          return t("validation.cronInvalid");
        }
      },
      definition_slug: (v: string): string | null => {
        if (v.length === 0) return null;
        return (DEFINITION_SLUGS as ReadonlyArray<string>).includes(v)
          ? null
          : t("validation.definitionUnknown");
      },
      scope_domain_ids: {
        async: async (
          v: string,
          _all,
          signal: AbortSignal,
        ): Promise<string | null> => {
          if (v.length === 0) return null;
          const picked = v.split(",").filter((s) => s.length > 0);
          if (picked.length === 0) return null;
          // PR-B4 (Copilot triage): match against a cached known-id
          // set; the GET fires at most once per modal session. The
          // server's submit-time `unknown_scope_domain_ids` 422
          // catches any race between cache load and submit.
          try {
            let known = domainIdCacheRef.current;
            if (known === null) {
              if (domainIdCacheLoadingRef.current === null) {
                domainIdCacheLoadingRef.current = (async (): Promise<
                  ReadonlySet<string>
                > => {
                  const resp = await fetchAdmin<{
                    rows: ReadonlyArray<{ id: string }>;
                  }>("/api/admin/domains", fetchOptsFor(props.fetchImpl));
                  const set = new Set(resp.rows.map((r) => r.id));
                  domainIdCacheRef.current = set;
                  return set;
                })();
              }
              known = await domainIdCacheLoadingRef.current;
            }
            if (signal.aborted) return null;
            const missing = picked.filter((id) => !known!.has(id));
            return missing.length === 0
              ? null
              : t("validation.scopeDomainMissing");
          } catch {
            return null;
          }
        },
      },
    },
  );

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
          helper={
            validation.name.status === "validating"
              ? t("validation.checking")
              : t("agentInstance.create.help.name")
          }
          validationStatus={validation.name.status}
          {...(errors["name"] !== undefined
            ? { error: errors["name"] }
            : validation.name.status === "invalid" &&
                validation.name.message !== null
              ? { error: validation.name.message }
              : {})}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LABEL_STYLE}>
            {t("agentInstance.create.fields.scopeDomainIds")}
            <span style={{ color: "var(--alert)" }} aria-hidden="true">
              {" "}
              *
            </span>
            <TooltipTrigger term="scopeDomainIds" />
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
          {/* PR-B4: live scope-domains validation. Submit-time
              `errors.scope_domain_ids` takes precedence; otherwise
              we surface a "checking…" chip while the async lookup
              is in flight, and an "invalid" chip when the picked
              IDs don't match the server's domains list. */}
          {errors["scope_domain_ids"] !== undefined ? (
            <p style={INLINE_ERROR_STYLE} role="alert">
              {errors["scope_domain_ids"]}
            </p>
          ) : validation.scope_domain_ids.status === "validating" ? (
            <p style={HELPER_STYLE}>{t("validation.checking")}</p>
          ) : validation.scope_domain_ids.status === "invalid" &&
            validation.scope_domain_ids.message !== null ? (
            <p style={INLINE_ERROR_STYLE} role="alert">
              {validation.scope_domain_ids.message}
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
          helper={
            validation.schedule_cron.status === "validating"
              ? t("validation.checking")
              : t("agentInstance.create.help.scheduleCron")
          }
          validationStatus={validation.schedule_cron.status}
          {...(errors["schedule_cron"] !== undefined
            ? { error: errors["schedule_cron"] }
            : validation.schedule_cron.status === "invalid" &&
                validation.schedule_cron.message !== null
              ? { error: validation.schedule_cron.message }
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
