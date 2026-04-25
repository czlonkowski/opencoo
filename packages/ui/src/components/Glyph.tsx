/**
 * Glyph — composable inline-SVG primitives from the opencoo
 * logo trio (open arc / filled disc / ring with dot).
 *
 * Per `design_system/README.md`: every icon in the v0.1 surfaces
 * is composable from these three primitives. Hand-rolled inline
 * SVG, 24px grid, 2px stroke. NO Lucide fallback in this PR;
 * if a future surface needs a concept the trio cannot express,
 * escalate to `team-lead` BEFORE adding the dep.
 *
 * The three components below are intentionally minimal — single-
 * primitive renders with `currentColor` fills/strokes so the
 * parent's color cascades through. Compose by stacking in the
 * same SVG when you need (open-arc + filled-disc, etc.) — this
 * file ships the primitives only.
 */
import type { CSSProperties } from "react";

export interface GlyphProps {
  /** Pixel size — defaults to 16px for inline contexts; the
   *  trio is designed on a 24px grid so common values are 16
   *  (inline) and 24 (standalone). */
  readonly size?: number;
  /** SVG title for accessibility — when omitted the glyph is
   *  decorative (`aria-hidden`). */
  readonly title?: string;
  readonly style?: CSSProperties;
}

/** Open arc — thin 2px-stroke arc; reserved for narrative
 *  accents. */
export function GlyphOpenArc(props: GlyphProps): JSX.Element {
  const size = props.size ?? 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden={props.title === undefined}
      role={props.title !== undefined ? "img" : undefined}
      style={props.style}
    >
      {props.title !== undefined ? <title>{props.title}</title> : null}
      <path d="M4 12 A8 8 0 0 1 20 12" />
    </svg>
  );
}

/** Filled disc — solid 14px disc on a 24px grid. Used as the
 *  "compile" / "compiled-knowledge" anchor glyph. */
export function GlyphFilledDisc(props: GlyphProps): JSX.Element {
  const size = props.size ?? 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden={props.title === undefined}
      role={props.title !== undefined ? "img" : undefined}
      style={props.style}
    >
      {props.title !== undefined ? <title>{props.title}</title> : null}
      <circle cx="12" cy="12" r="7" />
    </svg>
  );
}

/** Ring with dot — outer ring + inner dot. Used as the "operate"
 *  glyph; the heartbeat-pulse animation reserves this primitive
 *  for the agent layer. */
export function GlyphRingWithDot(props: GlyphProps): JSX.Element {
  const size = props.size ?? 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden={props.title === undefined}
      role={props.title !== undefined ? "img" : undefined}
      style={props.style}
    >
      {props.title !== undefined ? <title>{props.title}</title> : null}
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
