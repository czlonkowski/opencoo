/**
 * DebugBanner — `LLM_DEBUG_LOG=1` advisory strip (PR 29 / plan
 * #131; UX token-binding spec).
 *
 * Persistent strip across the top of the Chrome shell announcing
 * that the engine has `LLM_DEBUG_LOG=1` set and admin-API
 * responses are mirroring prompts/responses to
 * `llm_usage_debug`. NOT dismissible (sovereignty/forensics
 * signal). Advisory-amber bg — agent-layer prompts being
 * inspected.
 *
 * Token bindings:
 *   - bg: var(--advisory)
 *   - fg: var(--ink) (NOT advisory-ink — full ink for max
 *     legibility on amber)
 *   - border-bottom: 1px solid var(--advisory-ink)
 *   - padding: var(--space-3) var(--space-5)
 *   - text: var(--font-sans), 500, var(--fs-small)
 *   - emphasis chip (`LLM_DEBUG_LOG=1`): var(--font-mono), 600,
 *     var(--fs-mono); chip bg color-mix-in-oklch(var(--ink) 8%,
 *     transparent)
 *   - glyph: 16px ring-with-dot from the logo trio, currentColor
 *     (= var(--ink))
 *
 * Position: sticky top of the Chrome layout root.
 *
 * Hard-nos honored:
 *   - NOT dismissible (no X icon, no "hide for session").
 *   - NO animation, NO flash-on-mount, NO oscillation.
 *   - NO `--alert` (debug is advisory chrome, not destructive).
 *   - NO emoji — the operate ring-with-dot glyph is the marker.
 *   - NO marketing copy.
 *   - NO backdrop-blur, NO transparency.
 */
import type { CSSProperties } from "react";

import { GlyphRingWithDot } from "./Glyph.js";

const STRIP_STYLE: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 30,
  background: "var(--advisory)",
  color: "var(--ink)",
  borderBottom: "1px solid var(--advisory-ink)",
  padding: "var(--space-3) var(--space-5)",
  minHeight: 40,
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-small)",
  lineHeight: "var(--lh-small)",
};

const CHIP_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-mono)",
  color: "var(--ink)",
  background: "color-mix(in oklch, var(--ink) 8%, transparent)",
  borderRadius: "var(--radius-s)",
  padding: "2px var(--space-2)",
};

const PATH_TAIL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 500,
  fontSize: "var(--fs-mono)",
  color: "var(--ink)",
};

export interface DebugBannerProps {
  readonly visible: boolean;
}

/**
 * Exact target copy (per UX spec): the banner reads
 * `LLM_DEBUG_LOG=1 · prompts and responses are mirroring to
 * llm_usage_debug`. The chip + path-tail are mono; the prose
 * between them is sans (var(--font-sans), 500, --fs-small).
 *
 * The copy is hard-coded here rather than i18n'd — the env
 * var name + table name are technical identifiers; translating
 * them would change the meaning. Future locales translate
 * around the identifiers, not over them.
 */
export function DebugBanner(props: DebugBannerProps): JSX.Element | null {
  if (!props.visible) return null;
  return (
    <div role="status" style={STRIP_STYLE} data-testid="debug-banner">
      <GlyphRingWithDot
        size={16}
        title="operate"
        style={{ color: "var(--ink)", flexShrink: 0 }}
      />
      <span>
        <span style={CHIP_STYLE}>LLM_DEBUG_LOG=1</span>{" "}
        <span>· prompts and responses are mirroring to</span>{" "}
        <span style={PATH_TAIL_STYLE}>llm_usage_debug</span>
      </span>
    </div>
  );
}
