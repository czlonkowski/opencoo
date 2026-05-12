/**
 * DomainDetail — Domains row drill-down modal (PR-R1, phase-a
 * appendix #10).
 *
 * The Domains tab row click opens this modal. It exposes the three
 * lifecycle actions an operator needs to manage a typo'd or retired
 * domain entirely from the UI:
 *
 *   1. Edit `display_name`, `locale`, or `is_aggregator`. `slug`
 *      and `class` are NOT mutable here (rename = re-create; class
 *      is structural); the form does not even render fields for
 *      them.
 *   2. Disable (soft-delete) — sets `disabled_at` on the domain.
 *      Confirmation copy warns the operator that re-enable is NOT
 *      in v0.1 (one-way valve).
 *   3. Hard-delete — removes the row entirely. Refused with a
 *      helper message when bindings reference the domain. The
 *      destructive button gates behind a checkbox per the design-
 *      system rule for irreversible actions.
 *
 * Hard-nos honored (CLAUDE.md design system):
 *   - NO drop shadows for elevation (depth = border + bg shift)
 *   - NO advisory amber on destructive items — `--alert` only
 *   - NO emoji / NO marketing voice / NO spinners
 *   - lowercase `opencoo` in any future copy
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Modal } from "./Modal.js";
import { GlyphFilledDisc } from "./Glyph.js";
import {
  ApiAuthError,
  ApiTransientError,
  ApiValidationError,
  fetchAdmin,
  fetchOptsFor,
} from "../lib/api.js";
import type { Domain } from "../types.js";

export interface DomainDetailProps {
  readonly domain: Domain;
  /** Closes the modal (Esc, backdrop, "Close" button) AND fires
   *  after a successful Save / Disable / Delete action. */
  readonly onClose: () => void;
  /** Bumps the parent listing's refresh nonce after a successful
   *  mutation so the table re-fetches and the row picks up the new
   *  state. */
  readonly onChanged: () => void;
  /** @internal Test seam — defaults to globalThis.fetch via fetchAdmin. */
  readonly fetchImpl?: typeof fetch;
}

type Stage = "idle" | "disable" | "delete";

/** PR-W1 (phase-a appendix #13) — Recompile-worldview button
 *  disabled-window in ms. Mirrors the PR-Z3 Scan-now pattern: prevents
 *  the operator from spamming the endpoint while the recompile job is
 *  in flight. The server doesn't rate-limit the route in v0.1; this
 *  client-side gate is the only protection from accidental fork-
 *  bombing. 3s is generous enough for the operator to see the toast +
 *  short enough that a real retry after the toast clears succeeds. */
const RECOMPILE_WORLDVIEW_DISABLE_MS = 3000;

const TOAST_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--healthy)",
};

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

const ERROR_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--alert)",
  margin: 0,
};

const HELPER_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--ink-3)",
  margin: 0,
};

const ACTION_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "var(--space-3)",
  marginTop: "var(--space-3)",
  flexWrap: "wrap",
};

const DESTRUCTIVE_GROUP_STYLE: CSSProperties = {
  display: "flex",
  gap: "var(--space-3)",
};

const FORM_FIELD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const INPUT_STYLE: CSSProperties = {
  background: "var(--paper)",
  color: "var(--ink)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-2) var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
};

const CHECKBOX_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--fg-2)",
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

type LocaleOption = "en" | "pl" | "auto";

function isLocale(v: string): v is LocaleOption {
  return v === "en" || v === "pl" || v === "auto";
}

export function DomainDetail(props: DomainDetailProps): JSX.Element {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>("idle");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Form state mirrors current domain values; only fields that
  // changed are sent in the PATCH body.
  const [displayName, setDisplayName] = useState(props.domain.name);
  const [locale, setLocale] = useState<LocaleOption>(
    isLocale(props.domain.locale) ? props.domain.locale : "en",
  );
  const [isAggregator, setIsAggregator] = useState(props.domain.isAggregator);

  // Hard-delete confirmation gate — checkbox MUST be ticked before
  // the destructive button is enabled (design-system rule for
  // irreversible actions).
  const [hardDeleteAck, setHardDeleteAck] = useState(false);

  // PR-W1 (phase-a appendix #13) — Recompile-worldview button state.
  // `queued` flashes the success toast; `cooldown` keeps the button
  // disabled for `RECOMPILE_WORLDVIEW_DISABLE_MS`.
  const [recompileState, setRecompileState] = useState<
    "idle" | "queued" | "cooldown"
  >("idle");

  // Mounted ref so the cooldown clearTimeout doesn't setState into
  // a detached tree on rapid dismount.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const bindingCount = props.domain.bindingCount ?? 0;

  /** Map a thrown error to an operator-facing i18n string.
   *  Mirrors the SourceBindingDetail pattern (Q10b) so neither
   *  raw `err.message` nor the diagnostic shape leak into the UI. */
  const mapActionError = (err: unknown, defaultKey: string): string => {
    if (err instanceof ApiAuthError) {
      return t("domains.detail.errors.auth");
    }
    if (err instanceof ApiTransientError) {
      return t("domains.detail.errors.transient");
    }
    return t(defaultKey);
  };

  const submitSave = async (): Promise<void> => {
    setActionError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {};
      if (displayName !== props.domain.name) body["display_name"] = displayName;
      if (locale !== props.domain.locale) body["locale"] = locale;
      if (isAggregator !== props.domain.isAggregator) {
        body["is_aggregator"] = isAggregator;
      }
      // No-op submit (operator clicked Save without editing) — bail
      // without a round-trip rather than producing a 422 from the
      // server.
      if (Object.keys(body).length === 0) {
        props.onClose();
        return;
      }
      await fetchAdmin<{ id: string }>(
        `/api/admin/domains/${props.domain.id}`,
        {
          method: "PATCH",
          body,
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      props.onChanged();
      props.onClose();
    } catch (err) {
      // 409 aggregator_already_set has its own specific copy; the
      // operator needs to know which other domain currently holds
      // the flag.
      if (err instanceof ApiValidationError && err.status === 409) {
        const errBody = err.body as { error?: string } | undefined;
        if (errBody?.error === "aggregator_already_set") {
          setActionError(t("domains.detail.errors.aggregatorAlreadySet"));
          return;
        }
      }
      setActionError(mapActionError(err, "domains.detail.errors.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const submitDisable = async (): Promise<void> => {
    setActionError(null);
    setSubmitting(true);
    try {
      await fetchAdmin(
        `/api/admin/domains/${props.domain.id}`,
        {
          method: "DELETE",
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      props.onChanged();
      props.onClose();
    } catch (err) {
      setActionError(
        mapActionError(err, "domains.detail.errors.disableFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  /** PR-W1 (phase-a appendix #13) — POST `/api/admin/domains/:slug/recompile-worldview`.
   *
   *  Success path:
   *    1. POST → 202 with `{enqueued: true, jobId}`.
   *    2. Flash a `--healthy` toast for ~3s.
   *    3. Disable the button for `RECOMPILE_WORLDVIEW_DISABLE_MS` to
   *       prevent operator-spam (the server doesn't rate-limit yet).
   *
   *  Error paths route through the same `mapActionError` machinery
   *  the rest of this modal uses, with one extra branch for the
   *  composition-incomplete 503 surface so the copy points at engine
   *  config rather than blaming the operator.
   */
  const submitRecompileWorldview = async (): Promise<void> => {
    setActionError(null);
    setRecompileState("cooldown");
    try {
      await fetchAdmin<{ enqueued: boolean; jobId: string }>(
        `/api/admin/domains/${props.domain.slug}/recompile-worldview`,
        {
          method: "POST",
          body: {},
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      if (!mountedRef.current) return;
      setRecompileState("queued");
      window.setTimeout(() => {
        if (mountedRef.current) setRecompileState("idle");
      }, RECOMPILE_WORLDVIEW_DISABLE_MS);
    } catch (err) {
      if (!mountedRef.current) return;
      setRecompileState("idle");
      setActionError(
        mapActionError(err, "domains.detail.errors.recompileWorldviewFailed"),
      );
    }
  };

  const submitHardDelete = async (): Promise<void> => {
    setActionError(null);
    setSubmitting(true);
    try {
      await fetchAdmin(
        `/api/admin/domains/${props.domain.id}?hard=1`,
        {
          method: "DELETE",
          ...fetchOptsFor(props.fetchImpl),
        },
      );
      props.onChanged();
      props.onClose();
    } catch (err) {
      // 409 fk_restricted means bindings reference the domain and
      // the operator must migrate them first. Surface the specific
      // copy so the operator knows where to go (Sources tab).
      if (err instanceof ApiValidationError && err.status === 409) {
        setActionError(t("domains.detail.errors.deleteFkRestricted"));
      } else {
        setActionError(
          mapActionError(err, "domains.detail.errors.deleteFailed"),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onIdle = (): void => {
    setStage("idle");
    setActionError(null);
    setHardDeleteAck(false);
  };

  if (stage === "disable") {
    return (
      <Modal
        title={t("domains.detail.actions.confirmDisableTitle")}
        onClose={props.onClose}
        maxWidth={520}
        actions={
          <div style={CONFIRM_FOOTER_STYLE}>
            <Btn variant="ghost" onClick={onIdle} disabled={submitting}>
              {t("domains.detail.actions.cancel")}
            </Btn>
            <button
              type="button"
              disabled={submitting}
              onClick={(): void => {
                void submitDisable();
              }}
              style={DESTRUCTIVE_CONFIRM_BTN_STYLE}
            >
              {t("domains.detail.actions.confirmDisable")}
            </button>
          </div>
        }
      >
        <div style={SECTION_STYLE}>
          <p style={CONFIRM_BODY_STYLE}>
            {t("domains.detail.actions.confirmDisableBody")}
          </p>
          {actionError !== null ? (
            <p style={ERROR_TEXT_STYLE} role="alert">
              {actionError}
            </p>
          ) : null}
        </div>
      </Modal>
    );
  }

  if (stage === "delete") {
    const canConfirm = hardDeleteAck && !submitting && bindingCount === 0;
    return (
      <Modal
        title={t("domains.detail.actions.confirmDeleteTitle")}
        onClose={props.onClose}
        maxWidth={560}
        actions={
          <div style={CONFIRM_FOOTER_STYLE}>
            <Btn variant="ghost" onClick={onIdle} disabled={submitting}>
              {t("domains.detail.actions.cancel")}
            </Btn>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={(): void => {
                void submitHardDelete();
              }}
              style={{
                ...DESTRUCTIVE_CONFIRM_BTN_STYLE,
                opacity: canConfirm ? 1 : 0.55,
                cursor: canConfirm ? "pointer" : "not-allowed",
              }}
            >
              {t("domains.detail.actions.confirmDelete")}
            </button>
          </div>
        }
      >
        <div style={SECTION_STYLE}>
          <p style={CONFIRM_BODY_STYLE}>
            {t("domains.detail.actions.confirmDeleteBody")}
          </p>
          {bindingCount > 0 ? (
            <p style={ERROR_TEXT_STYLE} role="alert">
              {t("domains.detail.actions.deleteBlocked", { n: bindingCount })}
            </p>
          ) : null}
          <label style={CHECKBOX_ROW_STYLE}>
            <input
              type="checkbox"
              checked={hardDeleteAck}
              disabled={submitting || bindingCount > 0}
              onChange={(e): void => setHardDeleteAck(e.target.checked)}
            />
            {t("domains.detail.actions.confirmDeleteCheckbox")}
          </label>
          {actionError !== null ? (
            <p style={ERROR_TEXT_STYLE} role="alert">
              {actionError}
            </p>
          ) : null}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={t("domains.detail.title")}
      subtitle={t("domains.detail.subtitle")}
      onClose={props.onClose}
      maxWidth={620}
      actions={
        <div style={ACTION_ROW_STYLE}>
          <Btn variant="ghost" onClick={props.onClose} disabled={submitting}>
            {t("domains.detail.actions.close")}
          </Btn>
          <div style={DESTRUCTIVE_GROUP_STYLE}>
            {/* PR-W1 (phase-a appendix #13) — Recompile worldview.
             *  Disabled for `RECOMPILE_WORLDVIEW_DISABLE_MS` after a
             *  successful click so consecutive operator-clicks don't
             *  fork-bomb the worldview queue (the server doesn't rate-
             *  limit yet — v0.2 follow-up). Also disabled while the
             *  domain is soft-disabled (server returns 409 there
             *  anyway; this is the operator-visible affordance). */}
            <Btn
              variant="subtle"
              disabled={
                recompileState === "cooldown" ||
                recompileState === "queued" ||
                submitting ||
                (props.domain.disabledAt !== null &&
                  props.domain.disabledAt !== undefined)
              }
              onClick={(): void => {
                void submitRecompileWorldview();
              }}
            >
              {t("domains.detail.actions.recompileWorldview")}
            </Btn>
            <Btn
              variant="subtle"
              onClick={(): void => setStage("disable")}
              disabled={submitting}
            >
              {t("domains.detail.actions.disable")}
            </Btn>
            <Btn
              variant="ghost"
              onClick={(): void => setStage("delete")}
              disabled={submitting}
            >
              {t("domains.detail.actions.delete")}
            </Btn>
            <Btn
              variant="primary"
              onClick={(): void => {
                void submitSave();
              }}
              disabled={submitting}
            >
              {submitting
                ? t("domains.detail.actions.saving")
                : t("domains.detail.actions.save")}
            </Btn>
          </div>
        </div>
      }
    >
      <div style={SECTION_STYLE}>
        {/* Read-only identity block. */}
        <div style={FIELD_GRID_STYLE}>
          <span style={LABEL_STYLE}>{t("domains.detail.labels.slug")}</span>
          <span style={MONO_VALUE_STYLE}>{props.domain.slug}</span>

          <span style={LABEL_STYLE}>
            {t("domains.detail.labels.domainId")}
          </span>
          <span style={MONO_VALUE_STYLE}>{props.domain.id}</span>

          <span style={LABEL_STYLE}>{t("domains.detail.labels.class")}</span>
          <span style={VALUE_STYLE}>{props.domain.class}</span>

          <span style={LABEL_STYLE}>{t("domains.detail.labels.bindings")}</span>
          <span style={MONO_VALUE_STYLE}>{bindingCount}</span>
        </div>

        {/* Editable fields. */}
        <div style={FORM_FIELD_STYLE}>
          <label
            htmlFor="domain-detail-display-name"
            style={LABEL_STYLE}
          >
            {t("domains.detail.fields.displayName")}
          </label>
          <input
            id="domain-detail-display-name"
            type="text"
            value={displayName}
            disabled={submitting}
            onChange={(e): void => setDisplayName(e.target.value)}
            maxLength={120}
            style={INPUT_STYLE}
          />
        </div>

        <div style={FORM_FIELD_STYLE}>
          <label htmlFor="domain-detail-locale" style={LABEL_STYLE}>
            {t("domains.detail.fields.locale")}
          </label>
          <select
            id="domain-detail-locale"
            value={locale}
            disabled={submitting}
            onChange={(e): void => {
              const v = e.target.value;
              if (isLocale(v)) setLocale(v);
            }}
            style={INPUT_STYLE}
          >
            <option value="en">en</option>
            <option value="pl">pl</option>
            <option value="auto">auto</option>
          </select>
        </div>

        <label style={CHECKBOX_ROW_STYLE}>
          <input
            type="checkbox"
            checked={isAggregator}
            disabled={submitting}
            onChange={(e): void => setIsAggregator(e.target.checked)}
          />
          {t("domains.detail.fields.aggregator")}
        </label>

        {props.domain.disabledAt !== null &&
        props.domain.disabledAt !== undefined ? (
          <p style={HELPER_TEXT_STYLE}>
            {t("domains.detail.labels.disabledAt")}:{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>
              {props.domain.disabledAt}
            </code>
          </p>
        ) : null}

        {actionError !== null ? (
          <p style={ERROR_TEXT_STYLE} role="alert">
            {actionError}
          </p>
        ) : null}

        {/* PR-W1 (phase-a appendix #13) — Recompile-worldview success
         *  toast. Reuses the same `--healthy` filled-disc glyph the
         *  copy feedback uses in SourceBindingDetail so the operator
         *  gets a consistent "this worked" signal across the modal.
         *  Hidden in idle and cooldown-only states; visible only
         *  after a successful 202 lands. The button stays disabled
         *  until the cooldown window expires (which clears
         *  `recompileState` back to idle in one render). */}
        {recompileState === "queued" ? (
          <span
            style={TOAST_STYLE}
            role="status"
            data-testid="recompile-worldview-success"
          >
            <GlyphFilledDisc
              size={10}
              title="queued"
              style={{ color: "var(--healthy)" }}
            />
            {t("domains.detail.recompileWorldview.success")}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
