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
import { useLiveValidation } from "../hooks/useLiveValidation.js";

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
 * OR when the slugified result is shorter than the server's
 * minimum length (the SLUG_REGEX is `^[a-z][a-z0-9-]{1,62}$`,
 * so a 1-char result like "a" — produced by display name "A"
 * or "A!" — would auto-fill an invalid slug, get silently
 * written into the DOM, and only fail on POST. Empty is better
 * than wrong: the operator sees a blank slug and either types
 * one OR keeps typing into display-name until the auto-fill
 * produces a 2+ char slug. Also means the operator's typed-in
 * slug isn't accidentally overwritten by a length-changing
 * display-name edit. The validation step still rejects an empty
 * slug on submit.
 *
 * @internal Exported for unit-test access; not part of the
 *           component's public API.
 */
export function slugifyDisplayName(input: string): string {
  const lowered = input.toLowerCase().normalize("NFKD");
  // Strip combining marks (the diacritic portion of NFKD).
  const stripped = lowered.replace(/[̀-ͯ]/g, "");
  // Replace any run of non-[a-z0-9] with a single hyphen.
  const hyphenated = stripped.replace(/[^a-z0-9]+/g, "-");
  // Trim a leading prefix until the first letter (slug regex
  // requires `^[a-z]`) and any trailing hyphens.
  const trimmed = hyphenated.replace(/^[^a-z]+/, "").replace(/-+$/, "");
  // Slug regex caps at 63 chars total (1 letter + 1..62).
  const clamped = trimmed.slice(0, 63);
  // Reject sub-minimum-length results — server SLUG_REGEX
  // requires at least 2 chars (1 leading letter + 1+ trailing).
  if (clamped.length < 2) return "";
  return clamped;
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
  // PR-B4: shadow-state mirror for the live DOM values, so
  // useLiveValidation can react to operator keystrokes (and to
  // password-manager external setters that dispatch `input`).
  // The DOM remains the source of truth on submit; this state is
  // only read by the validation hook.
  const [liveValues, setLiveValues] = useState<{
    readonly slug: string;
    readonly display_name: string;
  }>({ slug: "", display_name: "" });

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
      // PR-B4: mirror live DOM value into React state so
      // useLiveValidation can observe operator keystrokes (and
      // password-manager external-setter dispatches).
      setLiveValues((cur) =>
        cur.slug === slugEl.value ? cur : { ...cur, slug: slugEl.value },
      );
    };

    const onDisplayInput = (): void => {
      if (!slugTouchedRef.current) {
        const next = slugifyDisplayName(displayEl.value);
        // Skip the write when the value is already correct — avoids
        // re-positioning the caret if the slug input happens to be
        // focused (the user can tab to it and start editing before
        // the regex test fires).
        if (slugEl.value !== next) {
          setInputValueNative(slugEl, next);
        }
      }
      // PR-B4: mirror both fields. Display-name may have auto-filled
      // the slug input above (which doesn't dispatch a new event
      // when we call the native setter without firing 'input'), so
      // pull both values out of the DOM here.
      setLiveValues((cur) => {
        const nextSlug = slugEl.value;
        const nextDisplay = displayEl.value;
        if (cur.slug === nextSlug && cur.display_name === nextDisplay) {
          return cur;
        }
        return { slug: nextSlug, display_name: nextDisplay };
      });
    };

    slugEl.addEventListener("input", onSlugInput);
    displayEl.addEventListener("input", onDisplayInput);
    return (): void => {
      slugEl.removeEventListener("input", onSlugInput);
      displayEl.removeEventListener("input", onDisplayInput);
    };
  }, []);

  // PR-B4: live validation. Sync slug-format runs on every input;
  // the async slug-uniqueness probe is debounced 250ms via the
  // hook and aborts on subsequent keystrokes. Display-name validation
  // is sync-only (length 2-100). The hook drives the `validationStatus`
  // prop slot the Field component shipped in PR-A3.
  const validation = useLiveValidation<{ slug: string; display_name: string }>(
    liveValues,
    {
      slug: {
        sync: (v: string): string | null => {
          if (v.length === 0) return null; // idle until typed
          return SLUG_REGEX.test(v)
            ? null
            : t("domains.create.errors.slugFormat");
        },
        async: async (
          v: string,
          _all: { slug: string; display_name: string },
          signal: AbortSignal,
        ): Promise<string | null> => {
          // GET the existing domains and check for a slug match.
          // Server-side authz + CSRF is carried by `fetchAdmin`;
          // we do NOT inline a raw fetch here (THREAT-MODEL §5).
          try {
            const resp = await fetchAdmin<{
              rows: ReadonlyArray<{ slug: string }>;
            }>("/api/admin/domains", {
              ...(props.fetchImpl !== undefined
                ? { fetchImpl: props.fetchImpl }
                : {}),
            });
            if (signal.aborted) return null;
            const hit = resp.rows.find((r) => r.slug === v);
            return hit !== undefined ? t("validation.slugTaken") : null;
          } catch {
            // Surface no error inline — the submit-time error path
            // still catches network failures with a generic message.
            return null;
          }
        },
      },
      display_name: (v: string): string | null => {
        if (v.length === 0) return null;
        const trimmed = v.trim();
        if (trimmed.length < 2) {
          return t("domains.create.errors.displayNameRequired");
        }
        if (trimmed.length > 100) {
          return t("domains.create.errors.displayNameRequired");
        }
        return null;
      },
    },
  );

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
          helper={
            validation.slug.status === "validating"
              ? t("validation.checking")
              : t("domains.create.help.slug")
          }
          validationStatus={validation.slug.status}
          {...(errors["slug"] !== undefined
            ? { error: errors["slug"] }
            : validation.slug.status === "invalid" &&
                validation.slug.message !== null
              ? { error: validation.slug.message }
              : {})}
        />
        <Field
          name="display_name"
          label={t("domains.create.fields.displayName")}
          inputRef={displayNameRef}
          defaultValue=""
          required
          validationStatus={validation.display_name.status}
          {...(errors["display_name"] !== undefined
            ? { error: errors["display_name"] }
            : validation.display_name.status === "invalid" &&
                validation.display_name.message !== null
              ? { error: validation.display_name.message }
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
