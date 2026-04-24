/**
 * HTML/script scrubber applied to whatever Markdown Docling returns.
 *
 * Zero dependencies — regex-based. We trust Docling's output for
 * everything EXCEPT six tag families and two attribute/URI shapes that
 * have no legitimate role in the compiled-wiki output and are high-risk
 * if they ever make it into a prompt. Content inside stripped tags is
 * removed along with the wrapper — leaving a `<script>…</script>` body
 * as prose would just reintroduce the payload at the `normalize` layer.
 *
 * Hardening notes (THREAT-MODEL §3.2):
 * - Paired form handles nested whitespace and multi-line bodies via
 *   the ungreedy `[\s\S]*?` + case-insensitive `i` + global `g`.
 * - Self-closing form covers `<embed … />` and `<input … />` shapes.
 * - `javascript:` URIs inside Markdown links are rewritten to `](#)`
 *   so the anchor text survives but the href is inert.
 * - `on*=` handler attributes (onclick, onmouseover, onload, …) are
 *   stripped regardless of whether the surrounding tag itself was
 *   stripped — belt-and-suspenders for residual inline HTML that
 *   doesn't match a scrubbed family (e.g. a `<button onclick=…>`).
 */

const TAG_FAMILIES = ["script", "style", "iframe", "object", "embed", "form"];

const PAIRED_TAG = new RegExp(
  `<(${TAG_FAMILIES.join("|")})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`,
  "gi",
);

const SELF_CLOSING_TAG = new RegExp(
  `<(${TAG_FAMILIES.join("|")})\\b[^>]*/>`,
  "gi",
);

// Markdown link with a `javascript:` (ws-tolerant) href. Matches both
// `](javascript:…)` and `](  JavaScript:…  )`. The replacement preserves
// the opening `](` so the link-text anchor survives intact.
const JAVASCRIPT_LINK_URI = /\]\(\s*javascript:[^)]*\)/gi;

// on*= attribute handlers. Two flavours: double-quoted value, single-
// quoted value. Unquoted values are a corner case (HTML5 permits them)
// but Docling never emits them and the regex cost isn't worth the
// additional false-positive surface area.
const ON_ATTR_DOUBLE = /\son[a-z]+\s*=\s*"[^"]*"/gi;
const ON_ATTR_SINGLE = /\son[a-z]+\s*=\s*'[^']*'/gi;

/**
 * Scrub hostile HTML from a Markdown string. Returns a NEW string — the
 * input is not mutated.
 */
export function stripHostileHtml(markdown: string): string {
  return markdown
    .replace(PAIRED_TAG, "")
    .replace(SELF_CLOSING_TAG, "")
    .replace(JAVASCRIPT_LINK_URI, "](#)")
    .replace(ON_ATTR_DOUBLE, "")
    .replace(ON_ATTR_SINGLE, "");
}
