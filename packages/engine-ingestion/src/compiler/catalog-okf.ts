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
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { parseFrontmatter } from "@opencoo/shared/page-spec";
import type {
  AgentRunId,
  DomainId,
  DomainSlug,
  SourceBindingId,
} from "@opencoo/shared/db";
import {
  wikiWrite,
  type WikiAuthor,
  type WikiWriteDeps,
  type WikiWriteInput,
} from "@opencoo/shared/wiki-write";

import { yamlQuoteIfNeeded } from "./frontmatter.js";
import { recordPageCitations } from "./page-citations.js";

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

/** Preserve the source OKF `timestamp` (OKF §4.1 "last meaningful change").
 *  gray-matter yields a Date for an unquoted ISO value and a string for a
 *  quoted one; both are normalised to ISO so the emitted page stays
 *  conformant. Falls back to `fallbackIso` when missing or unparseable. */
function resolveSourceTimestamp(raw: unknown, fallbackIso: string): string {
  if (raw instanceof Date) {
    if (!Number.isNaN(raw.getTime())) return raw.toISOString();
  } else if (typeof raw === "string" && raw.trim().length > 0) {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return fallbackIso;
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
  const timestamp = resolveSourceTimestamp(data["timestamp"], iso);

  const lines: string[] = [
    "---",
    `title: ${yamlQuoteIfNeeded(title)}`,
    `type: ${yamlQuoteIfNeeded(type)}`,
    `page_path: ${yamlQuoteIfNeeded(pagePath)}`,
    `domain_slug: ${yamlQuoteIfNeeded(args.domainSlug)}`,
    `compiled_at: ${yamlQuoteIfNeeded(iso)}`,
    `timestamp: ${yamlQuoteIfNeeded(timestamp)}`,
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

// ── Orchestrator ──────────────────────────────────────────────────

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface CompileOkfConceptArgs {
  readonly db: Db;
  readonly domainId: DomainId;
  readonly domainSlug: string;
  readonly bindingId: SourceBindingId;
  /** OKF concept id — the SourceEvent's sourceRef (path, no `.md`). */
  readonly sourceRef: string;
  /** Raw OKF concept markdown (frontmatter + body). */
  readonly content: string;
  readonly wikiDeps: WikiWriteDeps;
  readonly author: WikiAuthor;
  readonly compiledByRunId?: AgentRunId;
  readonly clock?: () => Date;
}

export interface CompileOkfConceptResult {
  readonly commitSha: string | null;
  readonly pagePath: string;
}

/** Strip a leading YAML frontmatter block (mirrors compiler.ts —
 *  duplicated to keep this module self-contained). */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return content;
  return content.slice(end + 5);
}

export async function compileOkfConcept(
  args: CompileOkfConceptArgs,
): Promise<CompileOkfConceptResult> {
  const clock = args.clock ?? ((): Date => new Date());
  const compiledAt = clock();
  const pagePath = catalogPagePathForOkfConcept(args.sourceRef);
  const built = buildOkfBundleBody({
    conceptId: args.sourceRef,
    content: args.content,
    domainSlug: args.domainSlug,
    compiledAt,
  });

  // Skip-write (matches the document + catalog-workflow compilers):
  // compare BODIES so a regenerated frontmatter timestamp doesn't
  // false-trigger a write.
  const existing = await args.wikiDeps.adapter.readPage(
    args.domainSlug as DomainSlug,
    pagePath,
  );
  if (
    existing !== null &&
    stripFrontmatter(existing.content) === built.bodyWithoutFrontmatter
  ) {
    args.wikiDeps.logger.info("compiler.catalog_okf.no-op", {
      domain_slug: args.domainSlug,
      page_path: pagePath,
      source_ref: args.sourceRef,
    });
    await tryRecordCitation(args, pagePath);
    return { commitSha: null, pagePath };
  }

  const writeInput: WikiWriteInput = {
    domainSlug: args.domainSlug,
    // Reuse the `[compiler]` tag — catalog-okf is a compiler-tier write
    // (deterministic, no LLM), same as catalog-workflow.
    tag: "[compiler]",
    description: `compile ${args.sourceRef} → ${pagePath}`,
    author: args.author,
    caller: { kind: "engine" },
    operations: [{ mode: "replace", path: pagePath, content: built.body }],
  };
  const result = await wikiWrite(args.wikiDeps, writeInput);
  await tryRecordCitation(args, pagePath);
  return { commitSha: result.sha, pagePath };
}

async function tryRecordCitation(
  args: CompileOkfConceptArgs,
  pagePath: string,
): Promise<void> {
  try {
    await recordPageCitations({
      db: args.db,
      domainSlug: args.domainSlug,
      pagePaths: [pagePath],
      sourceBindingId: args.bindingId,
      sourceRef: args.sourceRef,
      promptVersion: OKF_BUNDLE_PROMPT_VERSION,
      ...(args.compiledByRunId !== undefined
        ? { compiledByRunId: args.compiledByRunId }
        : {}),
    });
  } catch (err) {
    args.wikiDeps.logger.error("compiler.catalog_okf.page_citations.failed", {
      domain_slug: args.domainSlug,
      page_path: pagePath,
      source_ref: args.sourceRef,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
