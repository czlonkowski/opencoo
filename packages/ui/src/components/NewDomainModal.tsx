/**
 * NewDomainModal — `+ New domain` flow on the Domains tab
 * (phase-a appendix #2).
 *
 * Closes PRD §5 #1 ("default domain without manual DB edits").
 * Submits to POST /api/admin/domains; on success calls the
 * parent's onCreated so the list refetches.
 *
 * Validation:
 *   - slug regex must match the server's domains_slug_format
 *     CHECK constraint (^[a-z][a-z0-9-]{1,62}$).
 *   - display_name non-empty.
 *
 * Hard-nos honored:
 *   - primary CTA ink-on-paper (admin chrome, no advisory amber).
 *   - inline 'slug_taken' error on the slug field, NEVER an
 *     alert dialog or toast (CLAUDE.md design system).
 */
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Field } from "./Field.js";
import { Modal } from "./Modal.js";
import { PickerSelect } from "./PickerSelect.js";
import { ApiValidationError, fetchAdmin } from "../lib/api.js";

/** Slug regex pinned to the server domains_slug_format check. */
const SLUG_REGEX = /^[a-z][a-z0-9-]{1,62}$/;

const DOMAIN_CLASSES = ["knowledge", "catalog-workflows", "catalog-skills"] as const;
const LOCALES = ["en", "pl", "auto"] as const;

interface CreatedDomain {
  readonly id: string;
  readonly slug: string;
  readonly repoUrl: string;
}

export interface NewDomainModalProps {
  readonly onCreated: (created: CreatedDomain) => void;
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

export function NewDomainModal(props: NewDomainModalProps): JSX.Element {
  const { t } = useTranslation();
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [domainClass, setDomainClass] =
    useState<(typeof DOMAIN_CLASSES)[number]>("knowledge");
  const [locale, setLocale] = useState<(typeof LOCALES)[number]>("en");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!SLUG_REGEX.test(slug)) {
      next["slug"] = t("domains.create.errors.slugFormat");
    }
    if (displayName.trim().length === 0) {
      next["display_name"] = t("domains.create.errors.displayNameRequired");
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (): Promise<void> => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const result = await fetchAdmin<CreatedDomain>("/api/admin/domains", {
        method: "POST",
        body: {
          slug,
          class: domainClass,
          display_name: displayName,
          default_locale: locale,
        },
        ...(props.fetchImpl !== undefined ? { fetchImpl: props.fetchImpl } : {}),
      });
      props.onCreated(result);
    } catch (err) {
      if (
        err instanceof ApiValidationError &&
        err.status === 409 &&
        typeof err.body === "object" &&
        err.body !== null &&
        (err.body as { error?: string }).error === "slug_taken"
      ) {
        setErrors({ slug: t("domains.create.errors.slugTaken") });
      } else {
        // Generic surface; don't echo error.message (might
        // contain server-side context the operator can't act on).
        setErrors({ form: t("domains.create.errors.generic") });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={t("domains.create.title")}
      subtitle={t("domains.create.subtitle")}
      onClose={props.onClose}
      maxWidth={560}
      actions={
        <div style={FOOTER_STYLE}>
          <Btn variant="ghost" onClick={props.onClose}>
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
              ? t("domains.create.submitting")
              : t("domains.create.submit")}
          </Btn>
        </div>
      }
    >
      <div style={FIELDS_STYLE}>
        <Field
          name="slug"
          label={t("domains.create.fields.slug")}
          value={slug}
          onChange={(e): void => setSlug(e.target.value)}
          mono
          required
          helper={t("domains.create.help.slug")}
          {...(errors["slug"] !== undefined ? { error: errors["slug"] } : {})}
        />
        <Field
          name="display_name"
          label={t("domains.create.fields.displayName")}
          value={displayName}
          onChange={(e): void => setDisplayName(e.target.value)}
          required
          {...(errors["display_name"] !== undefined
            ? { error: errors["display_name"] }
            : {})}
        />
        <PickerSelect
          name="class"
          label={t("domains.create.fields.class")}
          value={domainClass}
          onChange={(v): void =>
            setDomainClass(v as (typeof DOMAIN_CLASSES)[number])
          }
          options={DOMAIN_CLASSES.map((c) => ({ value: c, label: c }))}
        />
        <PickerSelect
          name="default_locale"
          label={t("domains.create.fields.locale")}
          value={locale}
          onChange={(v): void => setLocale(v as (typeof LOCALES)[number])}
          options={LOCALES.map((l) => ({ value: l, label: l }))}
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
      </div>
    </Modal>
  );
}
