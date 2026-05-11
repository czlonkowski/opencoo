/**
 * NewDomainModal — `+ New domain` flow on the Domains tab
 * (phase-a appendix #2; PR-Z9 / G12 hardening).
 *
 * Closes PRD §5 #1 ("default domain without manual DB edits").
 * Submits to POST /api/admin/domains; on success calls the
 * parent's onCreated so the list refetches.
 *
 * Input pattern (PR-Z9, closes G12):
 *   The SLUG and DISPLAY-NAME inputs are UNCONTROLLED — React
 *   does not own `value`. The DOM is the source of truth and we
 *   read both via `useRef<HTMLInputElement>` on submit. This
 *   survives external native-value-setter bypasses (1Password,
 *   Bitwarden, programmatic JS-set) that previously corrupted
 *   the controlled-input state and swapped SLUG / DISPLAY-NAME
 *   values on the next React render. Validation state still
 *   lives in React (so the inline error rows + `aria-invalid`
 *   can re-render); it is recomputed on submit, not on each
 *   keystroke.
 *
 * Slug auto-fill:
 *   When the user has not yet typed in the slug field, edits to
 *   DISPLAY-NAME slugify into the slug input via a direct DOM
 *   write — NOT a React state round-trip. This keeps the
 *   auto-fill compatible with the uncontrolled pattern. A
 *   `slugTouchedRef` flag flips on the first `input` event that
 *   originated from the user editing the slug field directly,
 *   after which the auto-fill stops mirroring DISPLAY-NAME.
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
import { useEffect, useRef, useState, type CSSProperties } from "react";
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

/**
 * Slugify a display-name into the server's slug shape:
 *   - lowercase, ASCII-foldable diacritics stripped
 *   - non-[a-z0-9] collapsed to single hyphens
 *   - leading non-letter prefix trimmed (slug regex requires
 *     `^[a-z]`)
 *   - trailing hyphens trimmed
 *   - clamped to 63 chars (slug regex is `{1,62}` after the
 *     leading letter)
 *
 * Returns an empty string when the input has no usable letters
 * (so we don't write an invalid prefix into the slug input —
 * the validation step still rejects an empty slug on submit).
 */
function slugifyDisplayName(input: string): string {
  const lowered = input.toLowerCase().normalize("NFKD");
  // Strip combining marks (the diacritic portion of NFKD).
  const stripped = lowered.replace(/[̀-ͯ]/g, "");
  // Replace any run of non-[a-z0-9] with a single hyphen.
  const hyphenated = stripped.replace(/[^a-z0-9]+/g, "-");
  // Trim a leading prefix until the first letter (slug regex
  // requires `^[a-z]`) and any trailing hyphens.
  const trimmed = hyphenated.replace(/^[^a-z]+/, "").replace(/-+$/, "");
  // Slug regex caps at 63 chars total (1 letter + 1..62).
  return trimmed.slice(0, 63);
}

/**
 * Set an input's `.value` via the native HTMLInputElement
 * property setter so React's synthetic descriptor (which
 * tracks the last set value and skips re-fires) doesn't
 * swallow a downstream `input` event. Same technique used by
 * password-manager autofill scripts.
 */
function setInputValueNative(el: HTMLInputElement, value: string): void {
  const desc = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  );
  const setter = desc?.set;
  if (setter !== undefined) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
}

export function NewDomainModal(props: NewDomainModalProps): JSX.Element {
  const { t } = useTranslation();
  const slugRef = useRef<HTMLInputElement>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);
  // True once the user types directly into the slug field. After
  // that, edits to DISPLAY-NAME stop overwriting the slug input.
  // Stored on a ref (not React state) so the input-event handlers
  // are stable closures — no stale-closure bug.
  const slugTouchedRef = useRef<boolean>(false);
  const [domainClass, setDomainClass] =
    useState<(typeof DOMAIN_CLASSES)[number]>("knowledge");
  const [locale, setLocale] = useState<(typeof LOCALES)[number]>("en");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Subscribe to native `input` events directly on the DOM nodes
  // — bypasses React's synthetic event system entirely, which
  // means external value-setter bypasses (password managers,
  // QA scripts) reach our handler the same way real keystrokes
  // do. The subscription is wired once on mount.
  useEffect(() => {
    const slugEl = slugRef.current;
    const displayEl = displayNameRef.current;
    if (slugEl === null || displayEl === null) return;

    const onSlugInput = (): void => {
      // Mark slug as user-touched the first time we observe an
      // input event whose value differs from the synthetic
      // mirror we wrote during display-name slugify. We can't
      // distinguish "user typed" from "we wrote" by event type
      // alone (both bubble), so we treat any input event whose
      // value is NOT the current slugify of display-name as a
      // user edit. This keeps the regression behavior simple:
      // once the slug diverges from the display-name shadow,
      // we stop mirroring.
      const expected = slugifyDisplayName(displayEl.value);
      if (slugEl.value !== expected) {
        slugTouchedRef.current = true;
      }
    };

    const onDisplayInput = (): void => {
      if (slugTouchedRef.current) return;
      const next = slugifyDisplayName(displayEl.value);
      // Skip the write when the value is already correct — avoids
      // re-positioning the caret if the slug input happens to be
      // focused (the user can tab to it and start editing before
      // the regex test fires).
      if (slugEl.value !== next) {
        setInputValueNative(slugEl, next);
      }
    };

    slugEl.addEventListener("input", onSlugInput);
    displayEl.addEventListener("input", onDisplayInput);
    return (): void => {
      slugEl.removeEventListener("input", onSlugInput);
      displayEl.removeEventListener("input", onDisplayInput);
    };
  }, []);

  const validate = (slug: string, displayName: string): Record<string, string> => {
    const next: Record<string, string> = {};
    if (!SLUG_REGEX.test(slug)) {
      next["slug"] = t("domains.create.errors.slugFormat");
    }
    if (displayName.trim().length === 0) {
      next["display_name"] = t("domains.create.errors.displayNameRequired");
    }
    return next;
  };

  const submit = async (): Promise<void> => {
    // Read the live DOM values — NOT React state. The whole point
    // of PR-Z9: external scripts can mutate `.value` between
    // renders, so the input-element is the source of truth.
    const slug = slugRef.current?.value ?? "";
    const displayName = displayNameRef.current?.value ?? "";

    const validationErrors = validate(slug, displayName);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
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
          inputRef={slugRef}
          defaultValue=""
          mono
          required
          helper={t("domains.create.help.slug")}
          {...(errors["slug"] !== undefined ? { error: errors["slug"] } : {})}
        />
        <Field
          name="display_name"
          label={t("domains.create.fields.displayName")}
          inputRef={displayNameRef}
          defaultValue=""
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
