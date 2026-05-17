/**
 * Display — editorial-headline primitive (PR-C4, wave-16, phase-a
 * appendix #16).
 *
 * The ONLY legal call site for the Instrument Serif italic family
 * in the management console. Three strategic placements ship with
 * this PR — `routes/Reports.tsx`, `routes/Prompts.tsx` (empty
 * state), and `routes/Domains.tsx` — and a local ESLint rule
 * (`packages/ui/eslint.local.js`) rejects every other reference to
 * `var(--font-serif)` / `t-display` / `t-lede` / "Instrument
 * Serif" in `packages/ui/src/**`.
 *
 * The typescale classes live in `colors_and_type.css`:
 *
 *   - `t-display` (line 99) — serif italic at `--fs-display` (56px),
 *     reserved for a future docs site. `<Display level={1}>` maps
 *     here. The wave-16 brief notes the UI lints level=1 use
 *     inside the management console; the component itself does
 *     not enforce that (the ESLint rule + the cross-route
 *     snapshot test in `display-placement.test.tsx` are the
 *     gates).
 *   - `t-lede` (line 158) — serif italic at 28px / 1.25, reserved
 *     for editorial ledes. `<Display level={2|3}>` maps here.
 *
 * Inline `font-family` + `font-style` are emitted on every
 * render — deliberately. They are the marker the ESLint rule
 * upstream looks for, and they guarantee the editorial face survives
 * even if the stylesheet hasn't loaded yet (e.g. critical-path
 * render before fonts swap). Color is left to the class so the
 * W11 audit-fence ("no inline color literals") stays clean.
 *
 * `as` overrides the wrapper tag for non-heading contexts (e.g.
 * inside an empty-state panel whose surrounding card already
 * carries an h1; the lede then renders as a styled `<p>`).
 */
import type { CSSProperties, ReactNode } from "react";

export type DisplayLevel = 1 | 2 | 3;

/** Tag override — restricted to elements that make semantic sense
 *  for editorial copy. `h1|h2|h3` cover the default heading path;
 *  `p` covers non-heading lede placements. */
export type DisplayTag = "h1" | "h2" | "h3" | "p";

export interface DisplayProps {
  readonly level: DisplayLevel;
  /** Tag override. Defaults to the heading element matching `level`. */
  readonly as?: DisplayTag;
  readonly id?: string;
  readonly children: ReactNode;
}

function defaultTagFor(level: DisplayLevel): DisplayTag {
  switch (level) {
    case 1:
      return "h1";
    case 2:
      return "h2";
    case 3:
      return "h3";
  }
}

function classFor(level: DisplayLevel): string {
  // Level 1 maps to the display typescale (56px); levels 2 & 3
  // map to the lede typescale (28px / 1.25). Both classes share
  // the serif italic recipe; the size difference is intentional.
  return level === 1 ? "t-display" : "t-lede";
}

const INLINE_FONT_STYLE: CSSProperties = {
  fontFamily: "var(--font-serif)",
  fontStyle: "italic",
};

export function Display(props: DisplayProps): JSX.Element {
  const Tag = props.as ?? defaultTagFor(props.level);
  const className = classFor(props.level);
  // Cast is necessary because TypeScript cannot infer that every
  // member of `DisplayTag` accepts the same React HTML attributes;
  // both heading and paragraph elements accept `id`, `className`
  // and `style` so the call site is sound.
  const Element = Tag as unknown as React.ElementType;
  return (
    <Element
      className={className}
      style={INLINE_FONT_STYLE}
      {...(props.id !== undefined ? { id: props.id } : {})}
    >
      {props.children}
    </Element>
  );
}
