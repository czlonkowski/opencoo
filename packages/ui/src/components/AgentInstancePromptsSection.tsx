/**
 * AgentInstancePromptsSection — per-instance prompt-override
 * editor (PR-W7b, phase-a appendix #15).
 *
 * Second editing surface on top of W7a's per-domain editor.
 * Operates at the `agent-instances` scope of the W2 admin-API
 * (the API is scope-agnostic — same handler set is registered
 * for `domains` and `agent-instances`).
 *
 * Surface:
 *   - One row per prompt the instance's definition uses (mapped
 *     from `definition_slug → prompt_names[]` — heartbeat takes
 *     `heartbeat` + `worldview-domain`, lint/chat/surfacer/builder
 *     each take their namesake).
 *   - For each (prompt, locale) the row shows the resolution
 *     stack: shipped baseline → domain override (against the
 *     instance's `scope_domain_ids[0]`, since that's what the
 *     resolver falls through to per W2's resolveDomainId) →
 *     instance override.
 *   - Edit button opens a nested Modal hosting W7a's
 *     `PromptEditor` scoped to `agent-instances` with this
 *     instance's id. The preview/apply/refork/drift chain is
 *     scope-agnostic at the W2 API layer so it flows through
 *     unchanged.
 *   - Clear instance override button does DELETE through the
 *     `agent-instances` route. Confirmation via the same
 *     `RevertOverrideModal` W7a uses.
 *
 * Locale handling: en + pl rows are rendered when the instance's
 * locale is `auto`; only the matching locale otherwise (the
 * `agent_instances.locale` enum is `en | pl | auto`).
 *
 * Hard-nos honored: design-system tokens only, no gradients, no
 * emoji, `--alert` reserved for destructive Clear button.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { DiffPreviewDialog } from "./DiffPreviewDialog.js";
import { Modal } from "./Modal.js";
import { PromptEditor } from "./PromptEditor.js";
import { RevertOverrideModal } from "./RevertOverrideModal.js";
import {
  ApiValidationError,
  fetchAdmin,
  fetchOptsFor,
} from "../lib/api.js";
import type {
  AgentInstance,
  Domain,
  PromptOverridePreview,
} from "../types.js";

type PromptName =
  | "classifier"
  | "compiler"
  | "heartbeat"
  | "lint"
  | "chat"
  | "surfacer"
  | "builder"
  | "worldview-domain"
  | "worldview-company";

type Locale = "en" | "pl";

/** Mapping from `agent_instances.definition_slug` to the prompt
 *  names that definition's runtime actually invokes. Heartbeat
 *  pulls in both `heartbeat` (the report-shape prompt) and
 *  `worldview-domain` (the per-domain grounding compiled into
 *  each agent's system prompt per §7.5). The other four
 *  definitions each invoke a single namesake prompt. */
const DEFINITION_PROMPTS: Readonly<Record<string, ReadonlyArray<PromptName>>> = {
  heartbeat: ["heartbeat", "worldview-domain"],
  lint: ["lint"],
  chat: ["chat"],
  surfacer: ["surfacer"],
  builder: ["builder"],
};

interface SinglePromptResponse {
  readonly name: PromptName;
  readonly locale: Locale;
  readonly scope: "domains" | "agent-instances";
  readonly body: string;
  readonly version: string;
  readonly source: "baseline" | "override";
  readonly baselineVersion?: string;
  readonly isStale?: boolean;
}

interface ResolutionEntry {
  /** (prompt, locale) pair this stack describes. */
  readonly name: PromptName;
  readonly locale: Locale;
  /** Always present — shipped baseline manifest version. */
  readonly baselineVersion: string;
  /** Domain-scoped override against `scope_domain_ids[0]`,
   *  if any. */
  readonly domainOverride: {
    readonly version: string;
    readonly baselineVersion: string;
    readonly isStale: boolean;
  } | null;
  /** Instance-scoped override on this exact instance, if any. */
  readonly instanceOverride: {
    readonly version: string;
    readonly baselineVersion: string;
    readonly isStale: boolean;
  } | null;
}

interface ApplyDriftBody {
  readonly error: "baseline_version_drifted";
  readonly previewBaselineVersion: string;
  readonly currentBaselineVersion: string;
}

const SECTION_HEADING_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
  margin: 0,
  paddingTop: 8,
};

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const ROW_CARD_STYLE: CSSProperties = {
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-4)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  background: "var(--paper)",
};

const ROW_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  flexWrap: "wrap",
};

const PROMPT_NAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-mono)",
  color: "var(--fg-1)",
};

const LOCALE_TAG_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--ink-3)",
  marginLeft: 6,
};

const STACK_LINE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--ink-2)",
  paddingLeft: 12,
};

const STACK_LINE_DIM_STYLE: CSSProperties = {
  ...STACK_LINE_STYLE,
  color: "var(--ink-3)",
};

const ACTIONS_ROW_STYLE: CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
};

const HINT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--ink-3)",
  margin: 0,
};

const ERROR_BANNER_STYLE: CSSProperties = {
  border: "1px solid var(--alert)",
  background: "color-mix(in oklch, var(--alert) 8%, var(--paper))",
  padding: "var(--space-3) var(--space-4)",
  borderRadius: 3,
  color: "var(--alert)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
};

const TOAST_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--healthy)",
};

export interface AgentInstancePromptsSectionProps {
  readonly instance: AgentInstance;
  /** @internal Test seam. */
  readonly fetchImpl?: typeof fetch;
  /** Bumped by parent after a successful save so list refetch
   *  is debounced through the parent's `onChanged` lifecycle.
   *  Unused for v0.1 — internal nonce handles refresh. */
  readonly onChanged?: () => void;
}

export function AgentInstancePromptsSection(
  props: AgentInstancePromptsSectionProps,
): JSX.Element {
  const { t } = useTranslation();
  const opts = fetchOptsFor(props.fetchImpl);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const promptNames: ReadonlyArray<PromptName> =
    DEFINITION_PROMPTS[props.instance.definitionSlug] ?? [];

  const locales: ReadonlyArray<Locale> = useMemo(() => {
    const v = props.instance.locale;
    if (v === "en") return ["en"];
    if (v === "pl") return ["pl"];
    // `auto`, undefined, or any other value — render both locales.
    return ["en", "pl"];
  }, [props.instance.locale]);

  // `scope_domain_ids[0]` — the domain the resolver falls through
  // to when no instance override exists. Per W2, this is also
  // where any "domain override" the operator might create lives.
  const fallbackDomainId =
    props.instance.scopeDomainIds !== undefined &&
    props.instance.scopeDomainIds.length > 0
      ? props.instance.scopeDomainIds[0]!
      : null;

  // Domain catalog — slug for the resolution-stack label.
  const [domainSlug, setDomainSlug] = useState<string | null>(null);
  useEffect((): void => {
    if (fallbackDomainId === null) return;
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<{ rows: ReadonlyArray<Domain> }>(
          "/api/admin/domains",
          opts,
        );
        if (!mountedRef.current) return;
        const found = r.rows.find((d) => d.id === fallbackDomainId);
        setDomainSlug(found?.slug ?? fallbackDomainId);
      } catch {
        if (!mountedRef.current) return;
        setDomainSlug(fallbackDomainId);
      }
    })();
  }, [fallbackDomainId]);

  // Resolution stacks keyed by `${name}-${locale}`. We compute
  // each by issuing two GETs: one against the instance scope,
  // one against the domain scope (if `fallbackDomainId !== null`).
  // The agent-instances GET is the source of truth for whether
  // an instance override exists; the domain GET reveals what the
  // instance falls through to.
  const [stacks, setStacks] = useState<ReadonlyArray<ResolutionEntry>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshNonce, setRefreshNonce] = useState<number>(0);

  useEffect((): void => {
    setLoading(true);
    setLoadError(null);
    void (async (): Promise<void> => {
      try {
        const next: ResolutionEntry[] = [];
        for (const name of promptNames) {
          for (const locale of locales) {
            const instanceRow = await fetchAdmin<SinglePromptResponse>(
              `/api/admin/agent-instances/${props.instance.id}/prompts/${name}/${locale}`,
              opts,
            );
            let domainEntry: ResolutionEntry["domainOverride"] = null;
            if (fallbackDomainId !== null) {
              try {
                const domainRow = await fetchAdmin<SinglePromptResponse>(
                  `/api/admin/domains/${fallbackDomainId}/prompts/${name}/${locale}`,
                  opts,
                );
                if (domainRow.source === "override") {
                  domainEntry = {
                    version: domainRow.version,
                    baselineVersion:
                      domainRow.baselineVersion ?? domainRow.version,
                    isStale: domainRow.isStale === true,
                  };
                }
              } catch {
                // Best-effort — a domain-scope fetch failure
                // shouldn't block the instance editor.
              }
            }
            const instanceEntry: ResolutionEntry["instanceOverride"] =
              instanceRow.source === "override"
                ? {
                    version: instanceRow.version,
                    baselineVersion:
                      instanceRow.baselineVersion ?? instanceRow.version,
                    isStale: instanceRow.isStale === true,
                  }
                : null;
            // Baseline version: the GET response carries it on
            // override rows; on baseline rows the `version` IS the
            // baseline.
            const baselineVersion =
              instanceRow.baselineVersion ?? instanceRow.version;
            next.push({
              name,
              locale,
              baselineVersion,
              domainOverride: domainEntry,
              instanceOverride: instanceEntry,
            });
          }
        }
        if (!mountedRef.current) return;
        setStacks(next);
      } catch (err) {
        if (!mountedRef.current) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();
  }, [refreshNonce, props.instance.id]);

  // ── Editor lifecycle (nested modal) ───────────────────────────────────

  interface EditorState {
    readonly name: PromptName;
    readonly locale: Locale;
  }
  const [editorOpen, setEditorOpen] = useState<EditorState | null>(null);
  const [editorCurrent, setEditorCurrent] =
    useState<SinglePromptResponse | null>(null);
  const [proposedBody, setProposedBody] = useState<string>("");
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorLoading, setEditorLoading] = useState<boolean>(false);
  const [preview, setPreview] = useState<PromptOverridePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [drift, setDrift] = useState<{
    readonly previewBaselineVersion: string;
    readonly currentBaselineVersion: string;
  } | null>(null);
  const [appliedNotice, setAppliedNotice] = useState<string | null>(null);

  // Revert modal lifecycle (DELETE flow).
  const [revertTarget, setRevertTarget] = useState<EditorState | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  const closeEditor = useCallback((): void => {
    setEditorOpen(null);
    setEditorCurrent(null);
    setProposedBody("");
    setEditorError(null);
    setPreview(null);
    setPreviewError(null);
    setDrift(null);
    setAppliedNotice(null);
  }, []);

  const openEditor = (name: PromptName, locale: Locale): void => {
    setEditorOpen({ name, locale });
    setEditorLoading(true);
    setEditorError(null);
    setAppliedNotice(null);
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<SinglePromptResponse>(
          `/api/admin/agent-instances/${props.instance.id}/prompts/${name}/${locale}`,
          opts,
        );
        if (!mountedRef.current) return;
        setEditorCurrent(r);
        setProposedBody(r.body);
      } catch (err) {
        if (!mountedRef.current) return;
        setEditorError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current) setEditorLoading(false);
      }
    })();
  };

  const mapApplyError = (err: unknown): string => {
    if (err instanceof ApiValidationError) {
      const body = err.body as
        | { error?: string; reason?: string }
        | undefined;
      if (body?.reason === "payload_mismatch") {
        return t("prompts.editor.errors.payloadMismatch");
      }
      if (body?.reason === "expired") {
        return t("prompts.editor.errors.expired");
      }
      if (body?.reason === "signature_mismatch") {
        return t("prompts.editor.errors.signatureMismatch");
      }
    }
    return err instanceof Error ? err.message : String(err);
  };

  const onPreview = async (): Promise<void> => {
    if (editorOpen === null) return;
    setPreviewError(null);
    setDrift(null);
    try {
      const r = await fetchAdmin<PromptOverridePreview>(
        `/api/admin/agent-instances/${props.instance.id}/prompts/${editorOpen.name}/${editorOpen.locale}/preview`,
        { method: "POST", body: { proposedBody }, ...opts },
      );
      if (!mountedRef.current) return;
      setPreview(r);
    } catch (err) {
      if (!mountedRef.current) return;
      setPreviewError(mapApplyError(err));
    }
  };

  const onApply = async (): Promise<void> => {
    if (editorOpen === null || preview === null) return;
    try {
      await fetchAdmin(
        `/api/admin/agent-instances/${props.instance.id}/prompts/${editorOpen.name}/${editorOpen.locale}/apply`,
        {
          method: "POST",
          body: {
            proposedBody,
            token: preview.token,
            confirmDiff: true,
            baselineVersion: preview.baselineVersion,
          },
          ...opts,
        },
      );
      if (!mountedRef.current) return;
      setPreview(null);
      setAppliedNotice(t("prompts.editor.appliedToast"));
      // Refetch the resolution stack to surface the new override.
      setRefreshNonce((n) => n + 1);
      // Refresh the editor's `current` so the chips update without
      // closing the modal.
      try {
        const refreshed = await fetchAdmin<SinglePromptResponse>(
          `/api/admin/agent-instances/${props.instance.id}/prompts/${editorOpen.name}/${editorOpen.locale}`,
          opts,
        );
        if (!mountedRef.current) return;
        setEditorCurrent(refreshed);
        setProposedBody(refreshed.body);
      } catch {
        // The toast surfaced success already — a refetch hiccup
        // shouldn't bubble up as a destructive error.
      }
      props.onChanged?.();
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ApiValidationError) {
        const body = err.body as Partial<ApplyDriftBody> | undefined;
        if (body?.error === "baseline_version_drifted") {
          setPreview(null);
          setDrift({
            previewBaselineVersion: body.previewBaselineVersion ?? "",
            currentBaselineVersion: body.currentBaselineVersion ?? "",
          });
          return;
        }
      }
      setPreviewError(mapApplyError(err));
    }
  };

  const onRefork = (): void => {
    if (editorOpen === null) return;
    setDrift(null);
    // Re-fetch — the new baseline body becomes the new starting
    // point for editing.
    const target = editorOpen;
    setEditorLoading(true);
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<SinglePromptResponse>(
          `/api/admin/agent-instances/${props.instance.id}/prompts/${target.name}/${target.locale}`,
          opts,
        );
        if (!mountedRef.current) return;
        setEditorCurrent(r);
        setProposedBody(r.body);
      } catch (err) {
        if (!mountedRef.current) return;
        setEditorError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current) setEditorLoading(false);
      }
    })();
  };

  // ── Clear (DELETE) flow ──────────────────────────────────────────────

  const onClearConfirm = async (): Promise<void> => {
    if (revertTarget === null) return;
    setRevertError(null);
    try {
      await fetchAdmin(
        `/api/admin/agent-instances/${props.instance.id}/prompts/${revertTarget.name}/${revertTarget.locale}`,
        { method: "DELETE", ...opts },
      );
      if (!mountedRef.current) return;
      setRevertTarget(null);
      setAppliedNotice(t("prompts.editor.revertedToast"));
      setRefreshNonce((n) => n + 1);
      props.onChanged?.();
    } catch (err) {
      if (!mountedRef.current) return;
      setRevertError(mapApplyError(err));
    }
  };

  // ── Render ──────────────────────────────────────────────────────────

  if (promptNames.length === 0) {
    // Defensive — an unknown definition_slug just skips the
    // section rather than rendering an empty surface.
    return (
      <>
        <h3 style={SECTION_HEADING_STYLE}>
          {t("agentInstance.detail.prompts")}
        </h3>
        <p style={HINT_STYLE}>
          {t("agentInstance.detail.promptsUnknownDefinition")}
        </p>
      </>
    );
  }

  return (
    <>
      <h3 style={SECTION_HEADING_STYLE}>
        {t("agentInstance.detail.prompts")}
      </h3>
      <div style={SECTION_STYLE} data-testid="agent-instance-prompts-section">
        {loading ? (
          <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
        ) : loadError !== null ? (
          <div style={ERROR_BANNER_STYLE} role="alert">
            {loadError}
          </div>
        ) : (
          stacks.map((row) => {
            const rowKey = `${row.name}-${row.locale}`;
            const hasInstance = row.instanceOverride !== null;
            const hasDomain = row.domainOverride !== null;
            return (
              <div
                key={rowKey}
                style={ROW_CARD_STYLE}
                data-testid={`prompt-row-${rowKey}`}
              >
                <div style={ROW_HEADER_STYLE}>
                  <div>
                    <span style={PROMPT_NAME_STYLE}>{row.name}</span>
                    <span style={LOCALE_TAG_STYLE}>
                      (v{row.baselineVersion}
                      {" · "}
                      {row.locale})
                    </span>
                  </div>
                  <div style={ACTIONS_ROW_STYLE}>
                    <Btn
                      variant="ghost"
                      onClick={(): void => openEditor(row.name, row.locale)}
                    >
                      {t("agentInstance.detail.promptEdit")}
                    </Btn>
                    {hasInstance ? (
                      <Btn
                        variant="ghost"
                        onClick={(): void =>
                          setRevertTarget({
                            name: row.name,
                            locale: row.locale,
                          })
                        }
                      >
                        {t("agentInstance.detail.promptClearInstance")}
                      </Btn>
                    ) : null}
                  </div>
                </div>
                {hasInstance ? (
                  <div
                    style={STACK_LINE_STYLE}
                    data-testid={`stack-instance-${rowKey}`}
                  >
                    {t("agentInstance.detail.promptStack.instance", {
                      version: row.instanceOverride!.version,
                    })}
                  </div>
                ) : null}
                {hasDomain ? (
                  <div
                    style={STACK_LINE_STYLE}
                    data-testid={`stack-domain-${rowKey}`}
                  >
                    {t("agentInstance.detail.promptStack.domain", {
                      slug: domainSlug ?? fallbackDomainId ?? "",
                      version: row.domainOverride!.version,
                    })}
                  </div>
                ) : null}
                <div
                  style={STACK_LINE_DIM_STYLE}
                  data-testid={`stack-baseline-${rowKey}`}
                >
                  {t("agentInstance.detail.promptStack.baseline", {
                    version: row.baselineVersion,
                  })}
                </div>
              </div>
            );
          })
        )}
        {appliedNotice !== null && editorOpen === null ? (
          <div style={TOAST_STYLE} data-testid="prompts-section-toast">
            {appliedNotice}
          </div>
        ) : null}
      </div>

      {/* Nested editor modal */}
      {editorOpen !== null ? (
        <Modal
          onClose={closeEditor}
          title={t("agentInstance.detail.promptEditorTitle", {
            name: editorOpen.name,
            locale: editorOpen.locale,
          })}
          maxWidth={720}
        >
          {editorLoading ? (
            <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
          ) : editorError !== null ? (
            <div style={ERROR_BANNER_STYLE} role="alert">
              {editorError}
            </div>
          ) : editorCurrent !== null ? (
            <PromptEditor
              promptName={editorOpen.name}
              domainId={fallbackDomainId ?? ""}
              domains={[]}
              locale={editorOpen.locale}
              current={editorCurrent}
              proposedBody={proposedBody}
              onDomainChange={(): void => {
                // No-op for instance-scoped editor — the domain
                // selector is hidden via empty `domains` array
                // (the <select> renders with no options; the
                // operator can't change scope mid-edit).
              }}
              onLocaleChange={(): void => {
                // No-op — locale is fixed for an instance editor
                // session. Closing + re-opening the editor against
                // the other locale is the supported gesture.
              }}
              onProposedBodyChange={setProposedBody}
              onPreview={(): void => void onPreview()}
              onRevert={(): void => {
                setRevertTarget({
                  name: editorOpen.name,
                  locale: editorOpen.locale,
                });
              }}
              onOpenDebug={(): void => {
                // PromptDebugDrawer is keyed off domain in v0.1.
                // Skipped for instance scope — the parent's
                // Activity feed exposes the same payload bytes
                // for the instance's runs. Surface as a no-op so
                // the button still shows the affordance.
              }}
              previewError={previewError}
              drift={drift}
              onRefork={onRefork}
              appliedNotice={appliedNotice}
            />
          ) : null}
        </Modal>
      ) : null}

      {/* DiffPreviewDialog renders on top of the editor when a
          preview comes back. The dialog's `onApply` handler fires
          the apply request; the dialog stays mounted for the
          duration of the request so the operator sees the apply
          button's disabled-while-submitting state. */}
      {preview !== null && editorOpen !== null ? (
        <DiffPreviewDialog
          preview={preview}
          subtitle={`${editorOpen.name} · ${props.instance.name} · ${editorOpen.locale}`}
          onApply={onApply}
          onCancel={(): void => setPreview(null)}
          errorMessage={previewError}
        />
      ) : null}

      {/* Revert (DELETE) confirmation. Reuses W7a's modal which
          ships the ack-checkbox + i18n strings already. */}
      {revertTarget !== null ? (
        <RevertOverrideModal
          promptName={revertTarget.name}
          onConfirm={(): void => void onClearConfirm()}
          onClose={(): void => {
            setRevertTarget(null);
            setRevertError(null);
          }}
        />
      ) : null}
      {revertError !== null ? (
        <div style={ERROR_BANNER_STYLE} role="alert">
          {revertError}
        </div>
      ) : null}
    </>
  );
}
