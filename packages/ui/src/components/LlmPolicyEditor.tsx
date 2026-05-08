/**
 * LlmPolicyEditor — tier-by-tier dropdown editor for the
 * LLM-policy tab (PR-Q13, phase-a appendix #9).
 *
 * Replaces the prior raw-JSON textarea on `LlmPolicy.tsx`
 * with three coupled dropdowns (Thinker / Worker / Light)
 * sourced from the static catalog at GET /api/admin/llm-models.
 * The serialised value matches the prior textarea shape so the
 * existing preview/apply flow stays unchanged.
 *
 * Per-provider behaviour:
 *   - openai/anthropic/google → catalog dropdown only (or text
 *     input if the catalog fetch failed — see catalogFallback).
 *   - ollama → catalog is empty by design (operator pulled an
 *     arbitrary local model); dropdown is replaced by a
 *     custom-input field. Same fallback applies if a stored
 *     model isn't in the fetched catalog (Comment 2).
 *   - openrouter → catalog dropdown PLUS an "Other model…"
 *     sentinel option that swaps into a custom-input field
 *     so power users can pin any of OpenRouter's hundreds of
 *     models without an extra catalog edit. Auto-flips into
 *     custom-input mode when the persisted model isn't in the
 *     fetched catalog (Comment 2).
 *
 * onChange gating (Copilot triage round-2, Comment 1):
 *   The editor only emits onChange when ALL three tiers carry a
 *   non-empty model. Partial states (provider-only, mid-edit
 *   custom input) are reported via `onValidityChange` so the
 *   parent can disable Preview/Apply and surface the i18n
 *   "policy incomplete" message.
 *
 * The collapsible "Advanced (raw JSON)" section round-trips
 * dropdown ↔ textarea state. Edits in either surface flow to
 * the same internal state and emit the same onChange shape.
 *
 * Design-system bindings:
 *   - dropdowns use the same <select> styling as
 *     `PickerSelect.tsx` (no new tokens).
 *   - `local_only` checkbox is square (radius 2px, NOT a pill).
 *   - the "Advanced" section's expanded state cues with
 *     border + background-shift, NOT a drop shadow / accordion
 *     bounce — per design-system hard-no.
 *
 * Hard-nos honored:
 *   - NO advisory amber on this surface (admin config, not
 *     agent layer).
 *   - NO `--wiki` teal (this is policy chrome, not compiled-
 *     knowledge chrome).
 *   - NO emoji in any caption / label.
 *   - NO marketing voice ("AI-powered" / "intelligent" — none
 *     of those in copy).
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { fetchAdmin } from "../lib/api.js";

const TIERS = ["thinker", "worker", "light"] as const;
type Tier = (typeof TIERS)[number];

const PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "ollama",
  "openrouter",
] as const;
type Provider = (typeof PROVIDERS)[number];

/** Sentinel value the model dropdown emits when the operator
 *  picks the "Other model…" fallback. Triggers the swap to
 *  a custom-input field. The double-underscore guards against
 *  a real model id matching by accident — OpenRouter slugs
 *  are `<owner>/<model>` and never start with `__`. */
const CUSTOM_SENTINEL = "__custom__";

interface TierValue {
  readonly provider: Provider;
  readonly model: string;
}

/** Editor's internal canonical shape. The same shape the
 *  prior textarea emitted, so the LlmPolicy route's preview
 *  + apply round-trip is unchanged. */
export interface LlmPolicyValue {
  readonly thinker?: TierValue;
  readonly worker?: TierValue;
  readonly light?: TierValue;
  readonly local_only?: boolean;
  // Allow extra keys from the server's stored `llm_policy` to
  // pass through unchanged (e.g. v0.2's per-feature pins).
  readonly [k: string]: unknown;
}

export interface LlmPolicyEditorProps {
  readonly value: LlmPolicyValue;
  readonly onChange: (next: LlmPolicyValue) => void;
  /** Fired whenever the editor's "all three tiers have a model"
   *  invariant flips. Parent surfaces (Preview/Apply buttons,
   *  inline hint) toggle on this instead of the absence of
   *  onChange. Optional — components that don't care can omit it
   *  and they'll still get gated onChange events. */
  readonly onValidityChange?: (isComplete: boolean) => void;
  /** @internal Test seam — defaults to fetchAdmin. */
  readonly fetchImpl?: typeof fetch;
}

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const TIER_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 2fr",
  gap: "var(--space-3)",
  alignItems: "end",
};

const TIER_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  margin: 0,
};

const FIELD_LABEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--ink-2)",
};

const CAPTION_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--ink-3)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const SELECT_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
  padding: "8px 10px",
  background: "var(--paper)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  color: "var(--ink)",
};

const INPUT_STYLE: CSSProperties = {
  ...SELECT_STYLE,
  fontFamily: "var(--font-mono)",
};

const CHECKBOX_LABEL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--ink-2)",
};

const CHECKBOX_STYLE: CSSProperties = {
  // Square — no pill, per design-system hard-no.
  appearance: "auto",
  width: 16,
  height: 16,
  borderRadius: 2,
  cursor: "pointer",
};

const ADVANCED_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
};

const ADVANCED_BODY_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  padding: "var(--space-3)",
  // Border + background shift signals "expanded", per
  // design-system hard-no on drop-shadow elevation.
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  background: "var(--paper-2)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const TEXTAREA_STYLE: CSSProperties = {
  width: "100%",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  padding: "10px 12px",
  background: "var(--paper)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  color: "var(--ink)",
};

function isProvider(v: unknown): v is Provider {
  return (
    typeof v === "string" && (PROVIDERS as readonly string[]).includes(v)
  );
}

interface TierState {
  readonly provider: Provider;
  readonly model: string;
}

/** Read a `TierValue` out of the incoming `value` prop.
 *  Returns null when the slot is absent or shaped wrong; the
 *  editor falls back to a sensible default in that case. */
function parseTier(input: unknown): TierState | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const obj = input as Record<string, unknown>;
  const provider = obj["provider"];
  const model = obj["model"];
  if (!isProvider(provider) || typeof model !== "string") {
    return null;
  }
  return { provider, model };
}

const DEFAULT_TIER: TierState = { provider: "openai", model: "" };

interface EditorState {
  readonly thinker: TierState;
  readonly worker: TierState;
  readonly light: TierState;
  readonly local_only: boolean;
  /** Per-tier flag: did the operator explicitly opt into the
   *  "Other model…" custom-input fallback? Used by the
   *  openrouter dropdown — once flipped, the input stays
   *  rendered even while the model string is empty (the
   *  operator hasn't typed yet). Without this flag the input
   *  flickers back to the dropdown on the empty interim.
   *  Also auto-set on mount/policy-change for openrouter when
   *  the incoming model isn't in the fetched catalog (Comment 2),
   *  and for any provider when the catalog fetch failed and a
   *  stored model needs to remain editable (Comment 3). */
  readonly customMode: Readonly<Record<Tier, boolean>>;
  /** Whatever extra keys came in via `value` — passed through
   *  unchanged so unknown shapes (v0.2 per-feature pins) survive
   *  a round-trip. */
  readonly extras: Readonly<Record<string, unknown>>;
}

function valueToState(v: LlmPolicyValue): EditorState {
  const extras: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === "thinker" || k === "worker" || k === "light" || k === "local_only") {
      continue;
    }
    extras[k] = val;
  }
  return {
    thinker: parseTier(v.thinker) ?? DEFAULT_TIER,
    worker: parseTier(v.worker) ?? DEFAULT_TIER,
    light: parseTier(v.light) ?? DEFAULT_TIER,
    local_only: v.local_only === true,
    customMode: { thinker: false, worker: false, light: false },
    extras,
  };
}

function stateToValue(s: EditorState): LlmPolicyValue {
  return {
    ...s.extras,
    thinker: { provider: s.thinker.provider, model: s.thinker.model },
    worker: { provider: s.worker.provider, model: s.worker.model },
    light: { provider: s.light.provider, model: s.light.model },
    local_only: s.local_only,
  };
}

/** All three tiers carry a non-empty model — the gate the editor
 *  uses before emitting onChange (Comment 1). */
function isStateComplete(s: EditorState): boolean {
  return (
    s.thinker.model !== "" &&
    s.worker.model !== "" &&
    s.light.model !== ""
  );
}

/** Stable round-trip serializer. Used to detect "did the
 *  textarea content actually change vs. just re-render?" so
 *  we don't re-emit onChange in a loop. */
function canonicalize(v: LlmPolicyValue): string {
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) {
    ordered[k] = (v as Record<string, unknown>)[k];
  }
  return JSON.stringify(ordered, null, 2);
}

interface CatalogResponse {
  readonly catalog: Readonly<Record<Provider, readonly string[]>>;
}

export function LlmPolicyEditor(props: LlmPolicyEditorProps): JSX.Element {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<
    Readonly<Record<Provider, readonly string[]>> | null
  >(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [state, setState] = useState<EditorState>(() => valueToState(props.value));
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);
  const [rawText, setRawText] = useState<string>(() =>
    canonicalize(stateToValue(valueToState(props.value))),
  );
  const [rawError, setRawError] = useState<string | null>(null);

  // Track validity transitions so we only fire onValidityChange
  // when the gate flips, not on every re-render.
  const lastValidityRef = useRef<boolean | null>(null);
  const onValidityChangeRef = useRef<typeof props.onValidityChange>(props.onValidityChange);
  onValidityChangeRef.current = props.onValidityChange;

  // Fire onValidityChange once on mount (and on every external
  // re-seed below) so the parent reflects the current gate state
  // immediately — without this, a freshly-rendered editor with a
  // partial policy would leave the parent's "incomplete" hint
  // hidden until the operator actually edits something. The
  // empty-deps array is intentional: this runs once on mount;
  // post-mount re-seeds are handled by the next effect (driven
  // by `incomingKey`).
  useEffect(() => {
    const initial = isStateComplete(state);
    if (lastValidityRef.current !== initial) {
      lastValidityRef.current = initial;
      onValidityChangeRef.current?.(initial);
    }
  }, []);

  // Re-seed when the parent updates `value` from outside (e.g.
  // domain switch). We keep the textarea + dropdowns in sync.
  const incomingKey = useMemo(() => canonicalize(props.value), [props.value]);
  const lastSeededRef = useRef<string>(incomingKey);
  useEffect(() => {
    if (lastSeededRef.current === incomingKey) return;
    lastSeededRef.current = incomingKey;
    const next = valueToState(props.value);
    setState(next);
    setRawText(canonicalize(stateToValue(next)));
    setRawError(null);
    const isComplete = isStateComplete(next);
    if (lastValidityRef.current !== isComplete) {
      lastValidityRef.current = isComplete;
      onValidityChangeRef.current?.(isComplete);
    }
  }, [incomingKey, props.value]);

  // Load the catalog once on mount. If the fetch fails we still
  // render — the dropdowns just have no options, and the
  // catalog-null fallback path (Comment 3) renders text inputs
  // for every provider so a previously-saved model stays editable.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await (props.fetchImpl !== undefined
          ? (async (): Promise<CatalogResponse> => {
              const res = await props.fetchImpl!("/api/admin/llm-models", {
                method: "GET",
                credentials: "include",
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return (await res.json()) as CatalogResponse;
            })()
          : fetchAdmin<CatalogResponse>("/api/admin/llm-models"));
        if (!cancelled) setCatalog(r.catalog);
      } catch (err) {
        if (!cancelled) {
          setCatalogError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [props.fetchImpl]);

  // Auto-flip a tier into custom-input mode when its persisted
  // model can't be matched against the fetched catalog (Comment 2).
  // For openrouter and ollama this is the documented escape hatch;
  // we set it once the catalog resolves so the editor doesn't
  // briefly render a broken <select>. Other providers fall through
  // to the catalog-null fallback path in TierRow when needed
  // (Comment 3) — that path doesn't require customMode.
  useEffect(() => {
    if (catalog === null) return;
    setState((prev) => {
      let changed = false;
      const nextCustomMode = { ...prev.customMode };
      for (const tier of TIERS) {
        const tierState = prev[tier];
        if (tierState.model === "") continue;
        const isOpenrouterOrOllama =
          tierState.provider === "openrouter" || tierState.provider === "ollama";
        if (!isOpenrouterOrOllama) continue;
        const inCatalog = catalog[tierState.provider].includes(tierState.model);
        if (!inCatalog && !prev.customMode[tier]) {
          nextCustomMode[tier] = true;
          changed = true;
        }
      }
      if (!changed) return prev;
      return { ...prev, customMode: nextCustomMode };
    });
  }, [catalog]);

  /** Push a new editor state out via onChange + sync the
   *  raw-JSON textarea. onChange is gated by the "all three tiers
   *  have a non-empty model" invariant (Comment 1) — the editor
   *  signals partial states via onValidityChange instead of
   *  emitting a degenerate value. The textarea + internal state
   *  always reflect the latest edit; only the parent-visible
   *  callback is gated. */
  const commit = (next: EditorState): void => {
    setState(next);
    const value = stateToValue(next);
    setRawText(canonicalize(value));
    setRawError(null);
    const isComplete = isStateComplete(next);
    if (lastValidityRef.current !== isComplete) {
      lastValidityRef.current = isComplete;
      props.onValidityChange?.(isComplete);
    }
    if (isComplete) {
      props.onChange(value);
    }
  };

  const onTierChange = (tier: Tier, partial: Partial<TierState>): void => {
    const merged: TierState = { ...state[tier], ...partial };
    commit({ ...state, [tier]: merged });
  };

  const onProviderChange = (tier: Tier, provider: Provider): void => {
    // When the operator changes provider, clear the model
    // string so a stale value from the previous provider
    // doesn't accidentally submit. Pre-fill with the first
    // catalog entry when one is available — saves a click.
    const seedModel =
      catalog !== null && catalog[provider].length > 0
        ? catalog[provider][0]!
        : "";
    // Reset the per-tier custom-mode flag. Switching providers
    // is the natural "I'm starting over" signal.
    commit({
      ...state,
      [tier]: { provider, model: seedModel },
      customMode: { ...state.customMode, [tier]: false },
    });
  };

  const onCustomModeEnter = (tier: Tier): void => {
    // Operator picked "Other model…" — flip the flag, clear the
    // model string so the swapped-in input is empty + ready.
    commit({
      ...state,
      [tier]: { ...state[tier], model: "" },
      customMode: { ...state.customMode, [tier]: true },
    });
  };

  const onLocalOnlyToggle = (next: boolean): void => {
    commit({ ...state, local_only: next });
  };

  const onRawEdit = (text: string): void => {
    setRawText(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setRawError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      setRawError("must be a JSON object");
      return;
    }
    const next = valueToState(parsed as LlmPolicyValue);
    setState(next);
    setRawError(null);
    const isComplete = isStateComplete(next);
    if (lastValidityRef.current !== isComplete) {
      lastValidityRef.current = isComplete;
      props.onValidityChange?.(isComplete);
    }
    if (isComplete) {
      props.onChange(stateToValue(next));
    }
  };

  return (
    <div style={SECTION_STYLE}>
      {TIERS.map((tier) => (
        <TierRow
          key={tier}
          tier={tier}
          state={state[tier]}
          customMode={state.customMode[tier]}
          catalog={catalog}
          catalogError={catalogError}
          onProviderChange={(p): void => onProviderChange(tier, p)}
          onModelChange={(m): void => onTierChange(tier, { model: m })}
          onCustomModeEnter={(): void => onCustomModeEnter(tier)}
        />
      ))}

      <label style={CHECKBOX_LABEL_STYLE}>
        <input
          type="checkbox"
          name="local_only"
          checked={state.local_only}
          onChange={(e): void => onLocalOnlyToggle(e.target.checked)}
          style={CHECKBOX_STYLE}
        />
        <span>{t("llmPolicy.editor.localOnly")}</span>
      </label>

      <div>
        <button
          type="button"
          data-testid="advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={(): void => setAdvancedOpen((v) => !v)}
          style={ADVANCED_HEADER_STYLE}
        >
          <span>{t("llmPolicy.editor.advancedToggle")}</span>
          <span aria-hidden="true">{advancedOpen ? "−" : "+"}</span>
        </button>
        {advancedOpen ? (
          <div style={ADVANCED_BODY_STYLE}>
            <textarea
              name="raw-json"
              value={rawText}
              onChange={(e): void => onRawEdit(e.target.value)}
              rows={14}
              style={TEXTAREA_STYLE}
            />
            {rawError !== null ? (
              <div
                data-testid="raw-error"
                style={{
                  color: "var(--alert)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-micro)",
                }}
              >
                {rawError}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface TierRowProps {
  readonly tier: Tier;
  readonly state: TierState;
  /** OpenRouter/Ollama only — operator chose "Other model…"
   *  sentinel (or the auto-flip kicked in for a stale openrouter
   *  model that isn't in the fetched catalog). When true, render
   *  the custom-input field even if the model string happens to
   *  match a catalog entry. */
  readonly customMode: boolean;
  readonly catalog: Readonly<Record<Provider, readonly string[]>> | null;
  readonly catalogError: string | null;
  readonly onProviderChange: (p: Provider) => void;
  readonly onModelChange: (m: string) => void;
  readonly onCustomModeEnter: () => void;
}

function TierRow(props: TierRowProps): JSX.Element {
  const { t } = useTranslation();
  const { tier, state, catalog } = props;
  const models = catalog !== null ? catalog[state.provider] : [];
  const isOllama = state.provider === "ollama";
  const isOpenRouter = state.provider === "openrouter";
  // catalog === null means the fetch failed — fall back to a
  // text input for every provider so a previously-saved model
  // stays editable (Comment 3). Without this fallback openai/
  // anthropic/google would render an empty <select> and the
  // operator would be stuck.
  const catalogFallback = catalog === null;
  const useCustomInput =
    isOllama || (isOpenRouter && props.customMode) || catalogFallback;
  // The dropdown value: when in custom-mode for openrouter we
  // pin the visible select to the sentinel; otherwise the
  // current model id (or "" for the placeholder option).
  const dropdownValue =
    isOpenRouter && props.customMode ? CUSTOM_SENTINEL : state.model;

  // The "catalog unavailable" hint should ONLY render when no
  // working model is set — once the operator has a value in
  // the input, the hint is just noise (Comment 3).
  const showCatalogUnavailableHint =
    props.catalogError !== null && catalog === null && state.model === "";

  return (
    <div style={TIER_GRID_STYLE}>
      <div>
        <h3 style={TIER_LABEL_STYLE}>{tier}</h3>
        <label style={FIELD_LABEL_STYLE}>
          <span style={CAPTION_STYLE}>{t("llmPolicy.editor.captionProvider")}</span>
          <select
            name={`${tier}.provider`}
            value={state.provider}
            onChange={(e): void => props.onProviderChange(e.target.value as Provider)}
            style={SELECT_STYLE}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div>
        <label style={FIELD_LABEL_STYLE}>
          <span style={CAPTION_STYLE}>{t("llmPolicy.editor.captionModel")}</span>
          {useCustomInput ? (
            <input
              type="text"
              name={`${tier}.model`}
              value={state.model}
              onChange={(e): void => props.onModelChange(e.target.value)}
              placeholder={
                isOllama
                  ? t("llmPolicy.editor.ollamaPlaceholder")
                  : isOpenRouter
                    ? t("llmPolicy.editor.openrouterPlaceholder")
                    : t("llmPolicy.editor.customPlaceholder")
              }
              style={INPUT_STYLE}
            />
          ) : (
            <select
              name={`${tier}.model`}
              value={dropdownValue}
              onChange={(e): void => {
                const v = e.target.value;
                if (v === CUSTOM_SENTINEL) {
                  props.onCustomModeEnter();
                  return;
                }
                props.onModelChange(v);
              }}
              style={SELECT_STYLE}
            >
              {/* Empty placeholder when nothing is picked yet */}
              {state.model === "" && models.length > 0 ? (
                <option value="" disabled>
                  {t("llmPolicy.editor.pickModel")}
                </option>
              ) : null}
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {/* Stale-model fallback (PR-Q13 review): when the
                  incoming `state.model` is non-empty but missing
                  from the current provider's catalog (e.g. a DB
                  row that pre-dates a catalog edit, or a v0.2
                  server-pushed pin), surface it as an explicit
                  "(unknown)" option so the dropdown's `value`
                  matches an actual `<option>` and React doesn't
                  silently drop back to the first option. The
                  emitted state stays the stale value until the
                  operator picks a new one. */}
              {state.model !== "" && !models.includes(state.model) ? (
                <option key={state.model} value={state.model}>
                  {state.model} {t("llmPolicy.editor.unknownSuffix")}
                </option>
              ) : null}
              {isOpenRouter ? (
                <option value={CUSTOM_SENTINEL}>{t("llmPolicy.editor.otherModel")}</option>
              ) : null}
            </select>
          )}
        </label>
        {showCatalogUnavailableHint ? (
          <div
            style={{
              marginTop: 4,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)",
              color: "var(--alert)",
            }}
          >
            {t("llmPolicy.editor.catalogUnavailable")}
          </div>
        ) : null}
      </div>
    </div>
  );
}
