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
 * Adapter-specific credential rotation + config edit land in v0.2
 * — they require the schema-driven form renderer (mirroring
 * `SourceBindingDetail.tsx`'s Edit panel). For phase-a partner
 * cutover, Enable/Disable/Delete is enough to recover from a
 * mis-configured channel.
 */
import { useCallback, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Modal } from "./Modal.js";
import { SavingDot, type SavingDotState } from "./SavingDot.js";
import { useToast } from "./Toast.js";
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
        {error !== null ? (
          <div
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
