/**
 * catalog-okf — deterministic passthrough compile for
 * `content_kind: 'okf-bundle'` (PR-OKF3).
 *
 * `source-okf` emits one SourceEvent per OKF concept document; the
 * event `content` is the concept's raw markdown (frontmatter + body)
 * and `sourceRef` is its concept id (a bundle-relative path without
 * `.md`). This module:
 *
 *   1. Parses the OKF frontmatter (via @opencoo/shared/page-spec).
 *   2. Maps it to opencoo provenance frontmatter — preserving the OKF
 *      `type`/`title`/`description`/`resource`/`tags`, adding
 *      `page_path` / `domain_slug` / `compiled_at` / `timestamp` /
 *      `schema_version` / `source_id`. A concept with no `type` is
 *      imported permissively with a `Reference` fallback (OKF §9
 *      consumers tolerate).
 *   3. Commits the markdown body VERBATIM below the frontmatter — no
 *      fence, no LLM. The body round-trips byte-for-byte.
 *
 * MUST-NOT-IMPORT: no `@opencoo/shared/llm-router` — catalog-okf.test.ts
 * source-greps for that import as a regression guard (mirrors
 * catalog-workflow.ts).
 */
import { parseFrontmatter } from "@opencoo/shared/page-spec";

import { yamlQuoteIfNeeded } from "./frontmatter.js";

/** `prompt_version` sentinel for catalog-okf page_citations rows. */
export const OKF_BUNDLE_PROMPT_VERSION = "catalog-okf:1.0";
const SCHEMA_VERSION = "1.0.0";
/** Imported concept with no OKF `type` — permissive default (OKF §9). */
const FALLBACK_TYPE = "Reference";

/** Map an OKF concept id to its opencoo page path. The concept id is a
 *  bundle-relative path without `.md`; we mirror it (strip a leading
 *  slash + a redundant `.md`, then append `.md`). */
export function catalogPagePathForOkfConcept(conceptId: string): string {
  const id = conceptId
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.md$/i, "");
  return `${id}.md`;
}

function deriveTitleFromConceptId(conceptId: string): string {
  const base = conceptId.replace(/\.md$/i, "").split("/").pop() ?? conceptId;
  if (base.length === 0) return conceptId;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Non-empty (after trim) string frontmatter value, else null. */
function stringField(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const v = data[key];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

export interface BuildOkfBundleBodyArgs {
  readonly conceptId: string;
  readonly content: string;
  readonly domainSlug: string;
  readonly compiledAt: Date;
}

export interface BuildOkfBundleBodyResult {
  readonly body: string;
  /** Body MINUS frontmatter — for the skip-write no-op comparison. */
  readonly bodyWithoutFrontmatter: string;
}

export function buildOkfBundleBody(
  args: BuildOkfBundleBodyArgs,
): BuildOkfBundleBodyResult {
  const parsed = parseFrontmatter(args.content);
  const data = parsed.parseable ? parsed.data : {};
  const okfBody = parsed.body;

  const type = stringField(data, "type")?.trim() ?? FALLBACK_TYPE;
  const title =
    stringField(data, "title")?.trim() ??
    deriveTitleFromConceptId(args.conceptId);
  const pagePath = catalogPagePathForOkfConcept(args.conceptId);
  const iso = args.compiledAt.toISOString();

  const lines: string[] = [
    "---",
    `title: ${yamlQuoteIfNeeded(title)}`,
    `type: ${yamlQuoteIfNeeded(type)}`,
    `page_path: ${yamlQuoteIfNeeded(pagePath)}`,
    `domain_slug: ${yamlQuoteIfNeeded(args.domainSlug)}`,
    `compiled_at: ${yamlQuoteIfNeeded(iso)}`,
    `timestamp: ${yamlQuoteIfNeeded(iso)}`,
    `prompt_version: ${yamlQuoteIfNeeded(OKF_BUNDLE_PROMPT_VERSION)}`,
    `schema_version: ${yamlQuoteIfNeeded(SCHEMA_VERSION)}`,
    `source_id: ${yamlQuoteIfNeeded(args.conceptId)}`,
  ];

  // Preserve the recommended OKF fields when present + well-typed.
  const description = stringField(data, "description");
  if (description !== null) {
    lines.push(`description: ${yamlQuoteIfNeeded(description)}`);
  }
  const resource = stringField(data, "resource");
  if (resource !== null) {
    lines.push(`resource: ${yamlQuoteIfNeeded(resource)}`);
  }
  const tags = data["tags"];
  if (Array.isArray(tags) && tags.every((t) => typeof t === "string")) {
    const flow = (tags as readonly string[])
      .map((t) => yamlQuoteIfNeeded(t))
      .join(", ");
    lines.push(`tags: [${flow}]`);
  }

  lines.push("---");
  const frontmatter = lines.join("\n") + "\n";
  return {
    body: frontmatter + okfBody,
    bodyWithoutFrontmatter: okfBody,
  };
}
