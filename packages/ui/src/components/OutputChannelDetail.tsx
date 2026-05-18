/**
 * OutputChannelDetail — Outputs row drill-down modal.
 *
 * PR-Z4 (phase-a appendix #12 G5). Mirrors `SourceBindingDetail`'s
 * shape for consistency but ships a minimal v0.1 surface:
 *   - View the channel's `(adapter_slug, name, enabled)` row.
 *   - Toggle Enable / Disable via `PATCH {enabled}`.
 *   - Delete via DELETE — an inline confirmation step gates the
 *     destructive action.
 *
 * PR-Asana (wave-17 / phase-a appendix #17) — adds an Asana-only
 * inline editor for `assignee_gid`. Wave-14 W5 added the field to
 * the channel-config Zod schema and the heartbeat-to-Asana
 * transformer reads it; this is the operator-facing way to set or
 * clear it after the channel has been provisioned. The previous
 * "v0.2 schema-driven editor" note still holds for the other
 * Asana fields (`section_gid`, `due_date_policy`, `title_prefix`)
 * — only `assignee_gid` ships in this PR because that's the field
 * partners need today.
 *
 * Adapter-specific credential rotation + the schema-driven full
 * config-edit panel land in v0.2 (mirroring `SourceBindingDetail.tsx`'s
 * Edit panel). For phase-a partner cutover, Enable/Disable/Delete +
 * `assignee_gid` is enough.
 */
import { useCallback, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Modal } from "./Modal.js";
import { SavingDot, type SavingDotState } from "./SavingDot.js";
import { useToast } from "./Toast.js";
import { TooltipTrigger } from "./Tooltip.js";
import { useOptimisticPatch } from "../hooks/useOptimisticPatch.js";
import { ApiAuthError, ApiValidationError, fetchAdmin, fetchOptsFor } from "../lib/api.js";
import { safeErrorMessage } from "../lib/safe-error.js";
import type { OutputChannel } from "../types.js";

export interface OutputChannelDetailProps {
  readonly channel: OutputChannel;
  readonly onClose: () => void;
  readonly onChanged: () => void;
  /** @internal Test seam. */
  readonly fetchImpl?: typeof fetch;
}

type Stage = "idle" | "delete";

export function OutputChannelDetail(
  props: OutputChannelDetailProps,
): JSX.Element {
  const { t } = useTranslation();
  const toastApi = useToast();
  const [stage, setStage] = useState<Stage>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabledCueState, setEnabledCueState] =
    useState<SavingDotState>("idle");
  const opts = fetchOptsFor(props.fetchImpl);

  // ── Enabled toggle (optimistic, PR-B5) ─────────────────────────────────
  // Whitelist: `output_channels.enabled`. Click → label flips
  // immediately; PATCH lands in the background; rollback on failure.
  const applyEnabled = useCallback(
    async (next: boolean): Promise<boolean> => {
      setEnabledCueState("saving");
      setError(null);
      try {
        await fetchAdmin(`/api/admin/output-channels/${props.channel.id}`, {
          method: "PATCH",
          body: { enabled: next },
          ...opts,
        });
        setEnabledCueState("success");
        props.onChanged();
        return next;
      } catch (err) {
        setEnabledCueState("error");
        if (err instanceof ApiAuthError || err instanceof ApiValidationError) {
          setError(err.message);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
    },
    [props, opts],
  );
  const enabledOptimistic = useOptimisticPatch<boolean>(
    props.channel.enabled,
    applyEnabled,
    {
      rollbackToast: (err): void => {
        toastApi.alert({
          message: t("optimistic.savingError"),
          details: safeErrorMessage(err),
        });
      },
    },
  );
  const enabledValue = enabledOptimistic.value;

  const toggleEnabled = (): void => {
    if (enabledOptimistic.saving) return;
    enabledOptimistic.setValue(!enabledValue);
  };

  const onDelete = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fetchAdmin(`/api/admin/output-channels/${props.channel.id}`, {
        method: "DELETE",
        ...opts,
      });
      props.onChanged();
    } catch (err) {
      if (err instanceof ApiAuthError || err instanceof ApiValidationError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  // ── PR-Asana (wave-17): inline `assignee_gid` editor for Asana
  // channels. Local draft state + a manual Save button (no
  // optimistic-on-change like Enable/Disable — the operator types a
  // GID, then commits). Empty draft → field is dropped from the
  // PATCH body (the Asana Zod schema rejects ""; optional means
  // absent, not empty string).
  const isAsana = props.channel.adapterSlug === "asana";
  const initialAssignee =
    typeof props.channel.config["assignee_gid"] === "string"
      ? (props.channel.config["assignee_gid"] as string)
      : "";
  const [assigneeDraft, setAssigneeDraft] = useState<string>(initialAssignee);
  const [assigneeCueState, setAssigneeCueState] =
    useState<SavingDotState>("idle");
  const [assigneeBusy, setAssigneeBusy] = useState(false);

  const onSaveAssignee = async (): Promise<void> => {
    setAssigneeBusy(true);
    setAssigneeCueState("saving");
    setError(null);
    // Server PATCH `/config` is a full jsonb REPLACE — preserve every
    // existing key on the channel so a partial edit doesn't clobber
    // `project_gid`/`section_gid`/`title_prefix`/etc. Then set or
    // drop `assignee_gid` based on the draft.
    const nextConfig: Record<string, unknown> = { ...props.channel.config };
    const trimmed = assigneeDraft.trim();
    if (trimmed.length > 0) {
      nextConfig["assignee_gid"] = trimmed;
    } else {
      delete nextConfig["assignee_gid"];
    }
    try {
      await fetchAdmin(`/api/admin/output-channels/${props.channel.id}`, {
        method: "PATCH",
        body: { config: nextConfig },
        ...opts,
      });
      setAssigneeCueState("success");
      props.onChanged();
    } catch (err) {
      setAssigneeCueState("error");
      const msg =
        err instanceof ApiAuthError || err instanceof ApiValidationError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setError(msg);
      toastApi.alert({
        message: t("outputs.detail.asana.saveError"),
        details: safeErrorMessage(err),
      });
    } finally {
      setAssigneeBusy(false);
    }
  };

  const rowStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "120px 1fr",
    gap: 8,
    alignItems: "baseline",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--fs-micro)",
  };

  return (
    <Modal onClose={props.onClose} title={t("outputs.detail.title")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={rowStyle}>
          <div style={{ color: "var(--ink-3)" }}>
            {t("outputs.detail.labels.name")}
          </div>
          <div>{props.channel.name}</div>
        </div>
        <div style={rowStyle}>
          <div style={{ color: "var(--ink-3)" }}>
            {t("outputs.detail.labels.adapter")}
          </div>
          <div>{props.channel.adapterSlug}</div>
        </div>
        <div style={rowStyle}>
          <div style={{ color: "var(--ink-3)" }}>
            {t("outputs.detail.labels.state")}
            <SavingDot state={enabledCueState} />
          </div>
          <div>
            {enabledValue
              ? t("outputs.enabledYes")
              : t("outputs.enabledNo")}
          </div>
        </div>
        {isAsana ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              paddingTop: 8,
              borderTop: "1px solid var(--rule)",
            }}
          >
            <label
              htmlFor="output-channel-assignee-gid"
              style={{
                display: "inline-flex",
                alignItems: "center",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-micro)",
                color: "var(--ink-3)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {t("outputs.detail.asana.assigneeGidLabel")}
              <TooltipTrigger term="assigneeGid" />
              <SavingDot state={assigneeCueState} />
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                id="output-channel-assignee-gid"
                type="text"
                value={assigneeDraft}
                onChange={(e): void => setAssigneeDraft(e.target.value)}
                disabled={assigneeBusy}
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-mono)",
                  padding: "6px 8px",
                  border: "1px solid var(--rule)",
                  borderRadius: 4,
                  background: "var(--paper)",
                }}
              />
              <Btn
                variant="ghost"
                onClick={(): void => {
                  void onSaveAssignee();
                }}
                disabled={assigneeBusy}
                aria-label={t("outputs.detail.asana.saveAssignee")}
              >
                {assigneeBusy
                  ? t("outputs.detail.asana.savingAssignee")
                  : t("outputs.detail.asana.saveAssignee")}
              </Btn>
            </div>
          </div>
        ) : null}
        {error !== null ? (
          <div
            role="alert"
            style={{
              color: "var(--alert)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)",
            }}
          >
            {error}
          </div>
        ) : null}
        {stage === "idle" ? (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={props.onClose}>
              {t("outputs.detail.close")}
            </Btn>
            <Btn
              variant="ghost"
              onClick={toggleEnabled}
              disabled={busy || enabledOptimistic.saving}
            >
              {enabledValue
                ? t("outputs.detail.disable")
                : t("outputs.detail.enable")}
            </Btn>
            <Btn
              variant="ghost"
              onClick={(): void => setStage("delete")}
              disabled={busy}
            >
              {t("outputs.detail.delete")}
            </Btn>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              paddingTop: 8,
              borderTop: "1px solid var(--rule)",
            }}
          >
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)" }}>
              {t("outputs.detail.deleteConfirm")}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn
                variant="ghost"
                onClick={(): void => setStage("idle")}
                disabled={busy}
              >
                {t("outputs.detail.close")}
              </Btn>
              <Btn
                variant="ghost"
                onClick={(): void => {
                  void onDelete();
                }}
                disabled={busy}
              >
                {busy
                  ? t("outputs.detail.deleting")
                  : t("outputs.detail.delete")}
              </Btn>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
