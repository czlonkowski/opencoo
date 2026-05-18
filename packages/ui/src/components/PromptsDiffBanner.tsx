/**
 * PromptsDiffBanner — top-of-Prompts-tab strip surfacing prompts
 * that lag the latest `default-version` (PR 29 / plan #131; UX
 * token-binding spec).
 *
 * Wiki-Teal accent (prompts are compiled-knowledge chrome).
 * One row per drifting prompt with `acknowledge diff` link.
 *
 * v0.1 has no per-domain prompt-override surface yet, so the
 * banner mounts with an empty `lagging` list and renders
 * nothing — the component ships ready for the day prompt
 * overrides land (DECISIONS.md "prompt override surface").
 *
 * Token bindings:
 *   - bg: color-mix(in oklch, var(--wiki) 8%, var(--paper))
 *   - border: 1px solid var(--wiki); radius: var(--radius-l)
 *   - rail-left: 2px solid var(--wiki) (mirrors advisory-rail)
 *   - title: var(--font-sans), 500, var(--fs-body)
 *   - count numeral: var(--font-mono), 600, var(--fs-mono),
 *     var(--wiki)
 *   - row separator: 1px dashed var(--rule)
 *   - prompt-name: var(--font-mono), var(--fs-mono)
 *   - arrow + default-version: var(--wiki)
 *   - ack-link: var(--font-sans), 500, var(--fs-small),
 *     var(--ink); hover underline (no color shift)
 *
 * Hard-nos honored:
 *   - NEVER `--advisory` (these aren't agent-layer events).
 *   - NEVER `--alert` red (staleness is not destructive).
 *   - NO emoji, NO Lucide icons (filled-disc compile-glyph
 *     from logo trio).
 *   - NO per-row dismiss X (acknowledgement is the only
 *     action; dismissal would silently mask drift).
 *   - NO count badge in the sidebar nav (out of scope).
 *   - NO shadow, NO gradient.
 *   - link text is sans (UI affordance), NOT mono (mono is
 *     for paths/IDs only).
 *
 * Motion: NONE on the banner itself. Acknowledged rows
 * slide-out-up 160ms with var(--ease-transform); when the last
 * row is acknowledged the whole banner fades out 200ms.
 */
import { useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { GlyphFilledDisc } from "./Glyph.js";

export interface PromptVersionDrift {
  /** Prompt path / name as the operator sees it in the
   *  Prompts tab — e.g. `compiler` or `worldview-domain`. */
  readonly name: string;
  readonly currentVersion: string;
  readonly defaultVersion: string;
}

export interface PromptsDiffBannerProps {
  readonly lagging: ReadonlyArray<PromptVersionDrift>;
  /** Fired when the operator clicks `acknowledge diff` on a
   *  row. The parent persists the ack server-side. */
  readonly onAcknowledge?: (name: string) => Promise<void> | void;
}

const BANNER_STYLE: CSSProperties = {
  position: "relative",
  background: "color-mix(in oklch, var(--wiki) 8%, var(--paper))",
  border: "1px solid var(--wiki)",
  borderRadius: "var(--radius-l)",
  padding: "var(--space-4) var(--space-5)",
  marginBottom: "var(--space-4)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const RAIL_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  top: "var(--space-4)",
  bottom: "var(--space-4)",
  width: 2,
  background: "var(--wiki)",
  borderRadius: 2,
};

const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
};

const TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-body)",
  color: "var(--fg-1)",
  margin: 0,
};

const COUNT_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-mono)",
  color: "var(--wiki-ink)",
};

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

const ROW_BASE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-2) 0",
  borderTop: "1px dashed var(--rule)",
};

const PROMPT_NAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  color: "var(--fg-1)",
};

const VERSION_CURRENT_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--fg-3)",
};

const ARROW_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--wiki-ink)",
};

const VERSION_DEFAULT_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  color: "var(--wiki-ink)",
};

const ACK_LINK_STYLE: CSSProperties = {
  marginLeft: "auto",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-small)",
  color: "var(--ink)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: 0,
  textDecoration: "none",
};

export function PromptsDiffBanner(
  props: PromptsDiffBannerProps,
): JSX.Element | null {
  const { t } = useTranslation();
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [bannerFading, setBannerFading] = useState(false);

  const visible = useMemo(
    () => props.lagging.filter((p) => !acknowledged.has(p.name)),
    [props.lagging, acknowledged],
  );

  if (props.lagging.length === 0) return null;
  if (visible.length === 0 && !bannerFading) {
    // Last row just acknowledged — start the fade-out and
    // unmount after 200ms.
    setBannerFading(true);
    window.setTimeout(() => {
      setAcknowledged(new Set(props.lagging.map((p) => p.name)));
    }, 200);
  }

  const acknowledge = async (name: string): Promise<void> => {
    setAcknowledged((prev) => {
      const next = new Set(prev);
      next.add(name);
      return next;
    });
    if (props.onAcknowledge !== undefined) {
      await props.onAcknowledge(name);
    }
  };

  if (visible.length === 0 && bannerFading) {
    // Render nothing once the fade animation completes.
    return null;
  }

  return (
    <div
      role="status"
      data-testid="prompts-diff-banner"
      className={bannerFading ? "opencoo-banner-fade-out" : undefined}
      style={BANNER_STYLE}
    >
      <span style={RAIL_STYLE} aria-hidden="true" />
      <div style={HEADER_ROW_STYLE}>
        <GlyphFilledDisc
          size={16}
          title="compile"
          style={{ color: "var(--wiki)" }}
        />
        <h3 style={TITLE_STYLE}>
          <span style={COUNT_STYLE}>{visible.length}</span>{" "}
          {t("prompts.diffBanner.title", { count: visible.length })}
        </h3>
      </div>
      <div style={LIST_STYLE}>
        {visible.map((row) => (
          <div key={row.name} style={ROW_BASE_STYLE}>
            <span style={PROMPT_NAME_STYLE}>{row.name}</span>
            <span style={VERSION_CURRENT_STYLE}>v{row.currentVersion}</span>
            <span style={ARROW_STYLE}>→</span>
            <span style={VERSION_DEFAULT_STYLE}>v{row.defaultVersion}</span>
            <button
              type="button"
              style={ACK_LINK_STYLE}
              onClick={(): void => {
                void acknowledge(row.name);
              }}
              onMouseEnter={(e): void => {
                e.currentTarget.style.textDecoration = "underline";
              }}
              onMouseLeave={(e): void => {
                e.currentTarget.style.textDecoration = "none";
              }}
            >
              {t("prompts.diffBanner.acknowledge")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
