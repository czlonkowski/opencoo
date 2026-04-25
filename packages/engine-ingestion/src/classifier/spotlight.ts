/**
 * `spotlight()` — XML envelope around untrusted source content.
 *
 * Architecture §6.6 / THREAT-MODEL §3.4 Layer 1: the Classifier
 * prompt tells the model that everything inside
 * `<source_content>...</source_content>` is untrusted user data
 * and must NOT be obeyed as instructions. For that contract to
 * hold, the document body cannot be allowed to forge a closing
 * `</source_content>` tag (which would terminate the envelope
 * early) or open a `<system>` / `<assistant>` tag (which a model
 * might mistake for a chat-format role marker).
 *
 * Q3 decision: escape 6 sentinel families — open + close tags for
 * `source_content`, `system`, `assistant`. Case-insensitive so
 * `<SOURCE_CONTENT>` cannot smuggle through.
 *
 * Order matters: the `&` substitution MUST run first. If we
 * replaced `<system>` with `&lt;system&gt;` while leaving existing
 * `&` alone, an attacker could pre-encode `&amp;lt;system&amp;gt;`
 * which the model's HTML decoder might collapse to `&lt;system&gt;`
 * then to `<system>`. Escaping `&` first turns the attacker's
 * pre-encoded `&amp;` into `&amp;amp;` so no double-decode survives.
 *
 * Defense-in-depth note: even if a sentinel survived this layer,
 * the downstream Zod-strict + path-guard + binding-guard wall
 * still catches the resulting bad output. Spotlight is the cheap
 * outermost guard, not the only guard.
 */

export interface SpotlightArgs {
  readonly content: string;
  readonly source: string;
  readonly fetchedAt: Date;
}

const SENTINELS = ["source_content", "system", "assistant"] as const;

function escapeAmp(input: string): string {
  return input.replace(/&/g, "&amp;");
}

function escapeXmlBody(input: string): string {
  return input.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttr(input: string): string {
  return escapeXmlBody(escapeAmp(input)).replace(/"/g, "&quot;");
}

/**
 * Replace literal `<sentinel...>` and `</sentinel...>` byte
 * sequences in the body. The body has already had `&` escaped to
 * `&amp;`, so this is the only remaining place `<` can appear.
 * Case-insensitive so SHOUTED variants (`<SYSTEM>`) are caught.
 */
function escapeSentinels(body: string): string {
  let out = body;
  for (const tag of SENTINELS) {
    const open = new RegExp(`<(${tag})\\b`, "gi");
    const close = new RegExp(`</(${tag})\\b`, "gi");
    out = out.replace(open, "&lt;$1");
    out = out.replace(close, "&lt;/$1");
  }
  return out;
}

export function spotlight(args: SpotlightArgs): string {
  const sourceAttr = escapeXmlAttr(args.source);
  const fetchedAtAttr = args.fetchedAt.toISOString();
  // Amp-first → XML body → sentinel-tag neutralization. The order
  // is the security property; do not reorder without re-reading
  // the header comment above.
  const inner = escapeSentinels(escapeXmlBody(escapeAmp(args.content)));
  return `<source_content source="${sourceAttr}" fetched_at="${fetchedAtAttr}">${inner}</source_content>`;
}
