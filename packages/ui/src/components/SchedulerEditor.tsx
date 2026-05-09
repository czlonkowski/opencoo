/**
 * SchedulerEditor — inline cadence picker + custom-cron form for the
 * Activity → Pipelines → Scheduled-agents card list (PR-R6, phase-a
 * appendix #10).
 *
 * The operator clicks "Edit schedule" on a per-agent card; this
 * component expands inline and lets them either:
 *   - pick a preset (every weekday at HH:MM, every Sunday, first of
 *     month, bi-weekly first Sunday), or
 *   - type a custom cron pattern.
 *
 * The cron string is validated locally via `cron-parser` (same
 * library the engine uses); the "Next 5 fires" preview re-renders
 * on every keystroke. Save POSTs `PUT /api/admin/scheduler/:agent`
 * with `{ cron }`; on 200 the parent refetches the schedule list
 * and shows a "Schedule updated" feedback row.
 *
 * Design constraints (CLAUDE.md):
 *   - Save is a default-chrome button (NO `--alert` — this is an
 *     update, not a destructive action).
 *   - "Schedule updated" success uses `--healthy` (Healthy Green).
 *   - "Next 5 fires" is informational → `--ink-3` + JetBrains Mono.
 *   - The cron string echo + the next-5-fires dates are
 *     JetBrains Mono.
 *   - Cadence-picker labels use Geist (the default `--font-sans`).
 *   - NO emoji. NO motion loops (the heartbeat-pulse glyph is
 *     reserved for agent-layer Run-now). NO drop shadows.
 *   - Inline form — modal radius cap doesn't apply (the form lives
 *     in the agent card's row).
 */
import cronParser from "cron-parser";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ApiAuthError,
  ApiValidationError,
  fetchAdmin,
  fetchOptsFor,
} from "../lib/api.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type Preset =
  | "weekday"
  | "sunday"
  | "firstOfMonth"
  | "biweeklyFirstSunday"
  | "custom";

export interface SchedulerEditorProps {
  /** Agent slug — heartbeat / lint / surfacer / builder. The
   *  `:agent` URL param the PUT verb expects. */
  readonly agentSlug: "heartbeat" | "lint" | "surfacer" | "builder";
  /** The cron string the schedule list currently shows for this
   *  agent. The editor seeds the cadence picker from it; on
   *  cancel, the form reverts to it. */
  readonly currentCron: string;
  /** Called after a successful PUT — the parent refetches the
   *  schedule list so every visible card reflects the new cron. */
  readonly onApplied: () => void;
  /** Cancel handler — collapses the form back to the read-only
   *  card row. */
  readonly onCancel: () => void;
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Try to recognise a cron pattern as a known preset. Falls back
 *  to "custom" when the pattern doesn't match. The HH:MM
 *  recovery handles the most common preset shapes — the operator
 *  can still pick "custom" and the same pattern round-trips. */
function detectPreset(
  cron: string,
): { preset: Preset; hour: string; minute: string } {
  const trimmed = cron.trim();
  const fiveFields = trimmed.split(/\s+/);
  if (fiveFields.length === 5) {
    const [m, h, dom, mon, dow] = fiveFields as [
      string,
      string,
      string,
      string,
      string,
    ];
    const isInt = (s: string): boolean => /^\d+$/.test(s);
    if (isInt(m) && isInt(h)) {
      const hour = h.padStart(2, "0");
      const minute = m.padStart(2, "0");
      // every weekday at HH:MM → `M H * * 1-5`
      if (dom === "*" && mon === "*" && dow === "1-5") {
        return { preset: "weekday", hour, minute };
      }
      // every Sunday at HH:MM → `M H * * 0`
      if (dom === "*" && mon === "*" && dow === "0") {
        return { preset: "sunday", hour, minute };
      }
      // first of month at HH:MM → `M H 1 * *`
      if (dom === "1" && mon === "*" && dow === "*") {
        return { preset: "firstOfMonth", hour, minute };
      }
      // bi-weekly first Sunday at HH:MM → `M H 1-7 * 0`
      if (dom === "1-7" && mon === "*" && dow === "0") {
        return { preset: "biweeklyFirstSunday", hour, minute };
      }
    }
  }
  return { preset: "custom", hour: "09", minute: "00" };
}

/** Render the preset + HH:MM inputs back into a 5-field cron. */
function presetToCron(preset: Preset, hour: string, minute: string): string {
  const h = String(parseInt(hour, 10));
  const m = String(parseInt(minute, 10));
  switch (preset) {
    case "weekday":
      return `${m} ${h} * * 1-5`;
    case "sunday":
      return `${m} ${h} * * 0`;
    case "firstOfMonth":
      return `${m} ${h} 1 * *`;
    case "biweeklyFirstSunday":
      return `${m} ${h} 1-7 * 0`;
    default:
      // custom — caller passes the raw cron via the customCron
      // state branch. presetToCron should never hit this.
      return `${m} ${h} * * *`;
  }
}

/** Local cron validation — used to disable the Save button + drive
 *  the inline error message. The same `cron-parser` library + the
 *  same `tz: 'UTC'` invariant the engine pins. The friendly error
 *  text comes from i18n (`schedulerEditor.errors.cronInvalid`); the
 *  parser's raw reason isn't surfaced inline (the server's reply
 *  carries a richer `reason` for the post-Save error path). */
function isValidCron(pattern: string): boolean {
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    return false;
  }
  try {
    cronParser.parseExpression(pattern, { tz: "UTC" });
    return true;
  } catch {
    return false;
  }
}

/** Compute the next N firing instants for the preview. Returns an
 *  empty list when the pattern is invalid. */
function computeNextFires(pattern: string, count: number): string[] {
  try {
    const expr = cronParser.parseExpression(pattern, {
      tz: "UTC",
      currentDate: new Date(),
    });
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(expr.next().toDate().toISOString());
    }
    return out;
  } catch {
    return [];
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

const NEXT_FIRES_PREVIEW_COUNT = 5;

// Shared inline-style objects. Inlined CSS is the convention in
// this codebase (no Tailwind / CSS modules); pulling the repeated
// label + numeric-input shapes into named constants keeps the JSX
// scannable without changing rendered output.
const labelStyle = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--ink-2)",
} as const;

const fieldBoxStyle = {
  border: "1px solid var(--rule)",
  borderRadius: 3,
  background: "var(--paper)",
  color: "var(--ink)",
} as const;

const numericInputStyle = {
  ...fieldBoxStyle,
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  width: 56,
  padding: "4px 6px",
} as const;

const monoMutedStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--ink-3)",
} as const;

export function SchedulerEditor(props: SchedulerEditorProps): JSX.Element {
  const { t } = useTranslation();

  const initial = useMemo(() => detectPreset(props.currentCron), [
    props.currentCron,
  ]);
  const [preset, setPreset] = useState<Preset>(initial.preset);
  const [hour, setHour] = useState<string>(initial.hour);
  const [minute, setMinute] = useState<string>(initial.minute);
  const [customCron, setCustomCron] = useState<string>(props.currentCron);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // ── Derive the cron string from the current picker state ──
  const cron = useMemo(() => {
    if (preset === "custom") return customCron;
    return presetToCron(preset, hour, minute);
  }, [preset, hour, minute, customCron]);

  // ── Local cron validation (drives Save disabled + preview) ──
  const cronValid = useMemo(() => isValidCron(cron), [cron]);

  // ── Next-5-fires preview ──
  // `computeNextFires` already returns `[]` on invalid input, so no
  // extra guard is needed here.
  const nextFires = useMemo(
    () => computeNextFires(cron, NEXT_FIRES_PREVIEW_COUNT),
    [cron],
  );

  // ── Auto-clear the success-flash after 1.5s ──
  useEffect(() => {
    if (!savedFlash) return;
    const id = setTimeout(() => setSavedFlash(false), 1500);
    return () => clearTimeout(id);
  }, [savedFlash]);

  const handleSave = async (): Promise<void> => {
    if (!cronValid || saving) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      await fetchAdmin(`/api/admin/scheduler/${props.agentSlug}`, {
        method: "PUT",
        body: { cron },
        ...fetchOptsFor(props.fetchImpl),
      });
      setSavedFlash(true);
      props.onApplied();
    } catch (err) {
      // Map the typed errors back to friendly i18n strings.
      if (err instanceof ApiAuthError) {
        setErrorMessage(t("schedulerEditor.errors.auth"));
      } else if (
        err instanceof ApiValidationError &&
        err.status === 422 &&
        (err.body as { error?: string } | undefined)?.error === "cron_invalid"
      ) {
        const reason = (err.body as { reason?: string } | undefined)?.reason;
        setErrorMessage(
          typeof reason === "string" && reason.length > 0
            ? t("schedulerEditor.errors.cronInvalidWithReason", { reason })
            : t("schedulerEditor.errors.cronInvalid"),
        );
      } else if (
        err instanceof ApiValidationError &&
        err.status === 503
      ) {
        setErrorMessage(t("schedulerEditor.errors.schedulerUnavailable"));
      } else {
        setErrorMessage(t("schedulerEditor.errors.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const saveDisabled = !cronValid || saving;

  // ── Render ──
  return (
    <div
      data-testid="scheduler-editor"
      data-agent-slug={props.agentSlug}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "12px 0 4px",
        borderTop: "1px solid var(--rule)",
        marginTop: 8,
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Cadence preset row */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={labelStyle}>
          {t("schedulerEditor.presetLabel")}
        </label>
        <select
          aria-label={t("schedulerEditor.presetLabel")}
          value={preset}
          onChange={(e): void => setPreset(e.currentTarget.value as Preset)}
          disabled={saving}
          style={{
            ...fieldBoxStyle,
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            padding: "4px 8px",
          }}
        >
          <option value="weekday">{t("schedulerEditor.presets.weekday")}</option>
          <option value="sunday">{t("schedulerEditor.presets.sunday")}</option>
          <option value="firstOfMonth">{t("schedulerEditor.presets.firstOfMonth")}</option>
          <option value="biweeklyFirstSunday">{t("schedulerEditor.presets.biweeklyFirstSunday")}</option>
          <option value="custom">{t("schedulerEditor.presets.custom")}</option>
        </select>

        {preset !== "custom" && (
          <>
            <label style={labelStyle}>
              {t("schedulerEditor.timeLabel")}
            </label>
            <input
              aria-label="hour"
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={(e): void =>
                setHour(e.currentTarget.value.padStart(2, "0"))
              }
              disabled={saving}
              style={numericInputStyle}
            />
            <span
              aria-hidden
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                color: "var(--ink-3)",
              }}
            >
              :
            </span>
            <input
              aria-label="minute"
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(e): void =>
                setMinute(e.currentTarget.value.padStart(2, "0"))
              }
              disabled={saving}
              style={numericInputStyle}
            />
          </>
        )}
      </div>

      {/* Custom cron input — visible only when preset = custom */}
      {preset === "custom" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={labelStyle}>
            {t("schedulerEditor.cronLabel")}
          </label>
          <input
            aria-label={t("schedulerEditor.cronLabel")}
            type="text"
            value={customCron}
            onChange={(e): void => setCustomCron(e.currentTarget.value)}
            disabled={saving}
            spellCheck={false}
            data-testid="scheduler-editor-cron-input"
            style={{
              ...fieldBoxStyle,
              flex: 1,
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              padding: "4px 8px",
            }}
          />
        </div>
      )}

      {/* Cron string echo — JetBrains Mono, ink-3 (informational) */}
      <div data-testid="scheduler-editor-cron-echo" style={monoMutedStyle}>
        {cron}
      </div>

      {/* Inline cron-parse error */}
      {!cronValid && customCron.trim().length > 0 && (
        <div
          data-testid="scheduler-editor-error"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            color: "var(--alert)",
          }}
        >
          {t("schedulerEditor.errors.cronInvalid")}
        </div>
      )}

      {/* Next-5-fires preview */}
      {nextFires.length > 0 && (
        <div
          data-testid="scheduler-editor-next-fires"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "8px 0",
            borderTop: "1px dashed var(--rule)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              color: "var(--ink-3)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {t("schedulerEditor.nextFires")}
          </div>
          {nextFires.map((iso, i) => (
            <div key={i} style={monoMutedStyle}>
              {iso}
            </div>
          ))}
        </div>
      )}

      {/* Action row + feedback */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          paddingTop: 4,
        }}
      >
        <button
          type="button"
          onClick={(): void => {
            void handleSave();
          }}
          disabled={saveDisabled}
          data-testid="scheduler-editor-save"
          style={{
            font: "inherit",
            fontSize: 13,
            fontFamily: "var(--font-sans)",
            padding: "6px 14px",
            border: "1px solid var(--rule)",
            borderRadius: 3,
            background: saveDisabled ? "var(--paper-2)" : "var(--paper)",
            color: saveDisabled ? "var(--ink-3)" : "var(--ink)",
            cursor: saveDisabled ? "not-allowed" : "pointer",
          }}
        >
          {saving ? t("schedulerEditor.saving") : t("schedulerEditor.save")}
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          disabled={saving}
          data-testid="scheduler-editor-cancel"
          style={{
            font: "inherit",
            fontSize: 13,
            fontFamily: "var(--font-sans)",
            padding: "6px 14px",
            border: "1px solid transparent",
            borderRadius: 3,
            background: "transparent",
            color: "var(--ink-2)",
            cursor: saving ? "not-allowed" : "pointer",
          }}
        >
          {t("schedulerEditor.cancel")}
        </button>
        {savedFlash && (
          <span
            data-testid="scheduler-editor-applied"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              color: "var(--healthy)",
            }}
          >
            {t("schedulerEditor.applied")}
          </span>
        )}
        {errorMessage !== null && (
          <span
            data-testid="scheduler-editor-server-error"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              color: "var(--alert)",
            }}
          >
            {errorMessage}
          </span>
        )}
      </div>
    </div>
  );
}
