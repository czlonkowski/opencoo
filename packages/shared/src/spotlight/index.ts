/**
 * `spotlight()` — XML envelope around untrusted source content.
 *
 * Promoted from `engine-ingestion/classifier` (PR 15) to a
 * shared module in PR 19 because the agent harness in
 * engine-self-operating ALSO needs to spotlight external
 * memory content (run-history tails sourced from
 * `agent_runs.tool_calls[].result`) before injection into
 * agent prompts. The two engines must use byte-identical
 * envelope semantics or an attacker who poisons one engine's
 * input could pivot through the other (THREAT-MODEL §3.4 +
 * §3.5 memory poisoning).
 *
 * Architecture §6.6 / THREAT-MODEL §3.4 Layer 1: the prompt
 * tells the model that everything inside
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
 * Pipeline order is amp → sentinel → xmlbody, and each step is
 * load-bearing on the one before it.
 *
 * (1) `&` substitution MUST run first. If we replaced `<system>`
 *     with `&lt;system&gt;` while leaving existing `&` alone, an
 *     attacker could pre-encode `&amp;lt;system&amp;gt;` which the
 *     model's HTML decoder might collapse to `&lt;system&gt;` then
 *     to `<system>`. Escaping `&` first turns the attacker's
 *     pre-encoded `&amp;` into `&amp;amp;` so no double-decode
 *     survives.
 * (2) Sentinel rewriting MUST run on raw `<sentinel>` bytes —
 *     i.e. BEFORE `escapeXmlBody` turns `<` into `&lt;`. We rewrite
 *     the tag NAME (`<source_content` → `<source_content_escaped`),
 *     not the brackets, so even a model that decoded the entities
 *     back to `<…>` would not see a sentinel a downstream parser
 *     would recognize. Defense in depth on top of (3).
 * (3) `escapeXmlBody` runs last and handles the surviving `<` / `>`
 *     for general XML well-formedness — including the angle
 *     brackets we just emitted around the renamed sentinel tokens.
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
 * Rewrite the NAME of every literal `<sentinel...>` /
 * `</sentinel...>` opening byte by appending `_escaped`. Runs on
 * raw bytes (after escapeAmp, before escapeXmlBody) so it sees
 * unmodified `<` characters. The angle brackets are left in place
 * for escapeXmlBody to entity-encode in the next step.
 *
 * Case-insensitive so SHOUTED variants (`<SYSTEM>`) are caught
 * with the same suffix.
 */
function escapeSentinels(body: string): string {
  let out = body;
  for (const tag of SENTINELS) {
    const open = new RegExp(`<(${tag})\\b`, "gi");
    const close = new RegExp(`</(${tag})\\b`, "gi");
    out = out.replace(open, `<$1_escaped`);
    out = out.replace(close, `</$1_escaped`);
  }
  return out;
}

export function spotlight(args: SpotlightArgs): string {
  const sourceAttr = escapeXmlAttr(args.source);
  const fetchedAtAttr = args.fetchedAt.toISOString();
  // Amp → sentinel → xmlbody. The order is the security property;
  // do not reorder without re-reading the header comment above.
  // Sentinel rewriting MUST see raw `<` bytes, so it runs before
  // escapeXmlBody turns them into `&lt;`.
  const inner = escapeXmlBody(escapeSentinels(escapeAmp(args.content)));
  return `<source_content source="${sourceAttr}" fetched_at="${fetchedAtAttr}">${inner}</source_content>`;
}
