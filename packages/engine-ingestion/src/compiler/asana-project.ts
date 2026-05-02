/**
 * Asana-project compiler template (PR-H / phase-a appendix #4).
 *
 * Compiler template for `content_kind: 'asana-project'` bindings.
 * Receives a `ProjectSnapshot` from `source-asana` (PR-G shape) and
 * compiles it into a structured wiki page via a Worker-tier LLM call.
 *
 * Design decisions:
 *   1. Worker tier (not Thinker) — single-source merge, not strategic
 *      cross-document synthesis (§8.2 tier mapping).
 *   2. XML-spotlight wraps the snapshot JSON before inclusion in the
 *      LLM prompt (THREAT-MODEL §3.4). Snapshot task names are
 *      untrusted content from an external system.
 *   3. Exactly ONE wikiWrite per compile run (THREAT-MODEL §2 invariant 2).
 *      All page content is assembled in memory, then written atomically.
 *   4. Per-domain LLM policy enforced through the LlmRouter — no direct
 *      provider instantiation here.
 *   5. The § Notes section is operator-controlled territory: it is
 *      preserved verbatim from the existing page if one exists. The LLM
 *      only rewrites the four data-derived sections:
 *        ## Current state / ## Open tasks / ## Recent activity / ## Risks
 *   6. Output ≤40k chars — fail closed (CompilerValidationError) if exceeded.
 *
 * System prompt structure (mirrors PoC `Build Merge Prompt` Code node — 5 rules):
 *   1. ZWROC TYLKO pelny markdown — bez wstepu, bez podsumowania.
 *   2. Zachowaj YAML frontmatter + sekcje ## Notes BEZ ZMIAN.
 *   3. Sekcje ## Current state / ## Open tasks (top 10) / ## Recent activity
 *      (last 10) / ## Risks przepisujesz na podstawie aktualnego snapshotu.
 *   4. Cross-linki do innych stron wiki zostawiaj — nie zmyslaj sciezek.
 *   5. Output musi byc ≤40k znakow.
 */

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { LlmRouter } from "@opencoo/shared/llm-router";
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
import { spotlight } from "@opencoo/shared/spotlight";

import { CompilerValidationError } from "./errors.js";
import { recordPageCitations } from "./page-citations.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Maximum output size (characters). Fail-closed above this. */
const MAX_OUTPUT_CHARS = 40_000;

/**
 * `prompt_version` sentinel for asana-project page_citations rows.
 * The literal string is part of the persisted audit trail — change it
 * only via a deliberate template version bump.
 */
export const ASANA_PROJECT_PROMPT_VERSION = "asana-project:1.0";

/** Task row shape from the AsanaClient ProjectSnapshot. */
export interface AsanaTaskRow {
  readonly gid: string;
  readonly name: string;
  readonly assignee?: { readonly name: string } | null;
  readonly completed: boolean;
  readonly due_on: string | null;
  readonly modified_at: string;
  readonly memberships?: ReadonlyArray<{
    readonly section?: { readonly name: string };
  }>;
}

/**
 * ProjectSnapshot shape emitted by source-asana PR-G.
 * The compiler receives this as the `content_kind: 'asana-project'` payload.
 */
export interface AsanaProjectSnapshot {
  readonly project_gid: string;
  readonly snapshot: ReadonlyArray<AsanaTaskRow>;
  readonly incomplete_count: number;
  readonly overdue_count: number;
  readonly fetched_at: string; // ISO
}

/** Parsed sections from a compiled asana-project page body. */
export interface AsanaProjectSections {
  readonly currentState: string;
  readonly openTasks: string;
  readonly recentActivity: string;
  readonly risks: string;
}

/**
 * Lowercase, drop non-[a-z0-9] characters, dash-collapse spaces.
 * Falls back to `'project'` on empty or all-special inputs.
 */
function slugifyTitle(title: string): string {
  const lower = title.toLowerCase().normalize("NFKD");
  const replaced = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (replaced.length === 0) return "project";
  return replaced;
}

/**
 * Derive the wiki page path for an Asana project.
 * Format: `projects/<slug>-<gid>.md`
 */
export function asanaProjectPagePath(args: {
  readonly projectGid: string;
  readonly title: string;
}): string {
  return `projects/${slugifyTitle(args.title)}-${args.projectGid}.md`;
}

// ---------------------------------------------------------------------------
// System prompt (5 rules, mirrors PoC Build Merge Prompt)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Jesteś kompilatorem wiki dla projektu Asana. Twoje zadanie to zaktualizowac strone wiki na podstawie nowych danych.

ZASADY:
1. ZWROC TYLKO pelny markdown — bez wstepu, bez komentarzy, bez podsumowania. Zadnych dodatkowych slow.
2. Zachowaj YAML frontmatter + sekcje ## Notes BEZ ZMIAN — to teren operatora. Jesli strona nie istnieje, stworz tylko nowy frontmatter i pomijaj ## Notes.
3. Sekcje ## Current state, ## Open tasks (top 10 niezakonczonych), ## Recent activity (ostatnie 10 zdarzen z metadanych), ## Risks przepisujesz w calosci na podstawie aktualnego snapshotu.
4. Cross-linki do innych stron wiki zostawiaj — nie wymyslaj nowych sciezek, nie usuwaj istniejacych.
5. Output musi byc =<40000 znakow. Jesli to konieczne, skracaj listy, nie frontmatter ani sekcje systemowe.`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildLlmPrompt(
  snapshot: AsanaProjectSnapshot,
  existingPageContent: string | null,
  sourceRef: string,
  pagePath: string,
): string {
  const fetchedAt = new Date(snapshot.fetched_at);
  const snapshotJson = JSON.stringify(snapshot, null, 2);
  const spotlighted = spotlight({
    content: snapshotJson,
    source: sourceRef,
    fetchedAt,
  });

  const lines: string[] = [
    SYSTEM_PROMPT,
    "",
    "---",
    "",
  ];

  if (existingPageContent !== null && existingPageContent.trim().length > 0) {
    const spotlitExisting = spotlight({
      content: existingPageContent,
      source: `wiki:${pagePath}`,
      fetchedAt: fetchedAt,
    });
    lines.push(spotlitExisting);
    lines.push("");
  }

  lines.push("Aktualny snapshot projektu:");
  lines.push(spotlighted);
  lines.push("");
  lines.push("Zwroc zaktualizowany pelny markdown strony wiki.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Frontmatter builder
// ---------------------------------------------------------------------------

function buildFrontmatter(args: {
  readonly title: string;
  readonly pagePath: string;
  readonly domainSlug: string;
  readonly compiledAt: Date;
  readonly snapshot: AsanaProjectSnapshot;
  readonly compiledByRunId?: AgentRunId;
}): string {
  const escapedTitle = args.title.replace(/"/g, '\\"');
  const lines = [
    "---",
    `title: "${escapedTitle}"`,
    `type: asana-project`,
    `last_updated: "${args.compiledAt.toISOString()}"`,
    `asana_project_gid: "${args.snapshot.project_gid}"`,
    `status: active`,
    `schema_version: "1.0.0"`,
    `compiled_at: "${args.compiledAt.toISOString()}"`,
    `prompt_version: "${ASANA_PROJECT_PROMPT_VERSION}"`,
    `domain_slug: "${args.domainSlug}"`,
    `page_path: "${args.pagePath}"`,
    `compiled_by_run_id: ${args.compiledByRunId ?? null}`,
    "---",
  ];
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Section parser
// ---------------------------------------------------------------------------

/**
 * Parse the four rewritable sections from a compiled asana-project page body.
 * Section boundaries are detected by `## <SectionName>` headings.
 *
 * **Best-effort, no-throw by design.** Missing sections return empty strings
 * rather than raising. Round-trip cleanness is asserted by the test suite,
 * but downstream callers (e.g. lint, surfacer) tolerate partial pages —
 * throwing here would break those agents on any malformed page in the wild.
 */
export function parseAsanaProjectSections(body: string): AsanaProjectSections {
  const SECTIONS = [
    { key: "currentState", heading: "## Current state" },
    { key: "openTasks", heading: "## Open tasks" },
    { key: "recentActivity", heading: "## Recent activity" },
    { key: "risks", heading: "## Risks" },
  ] as const;

  const result: Record<(typeof SECTIONS)[number]["key"], string> = {
    currentState: "",
    openTasks: "",
    recentActivity: "",
    risks: "",
  };

  for (const section of SECTIONS) {
    const start = body.indexOf(section.heading);
    if (start === -1) continue;
    const contentStart = start + section.heading.length;

    // Section ends at the next known heading (## Current state / ## Open
    // tasks / ## Recent activity / ## Risks / ## Notes), or end of body.
    let end = body.length;
    const nextHeadings = [
      ...SECTIONS.filter((s) => s.key !== section.key).map((s) => s.heading),
      "## Notes",
    ];
    for (const heading of nextHeadings) {
      const nextStart = body.indexOf(heading, contentStart);
      if (nextStart !== -1 && nextStart < end) end = nextStart;
    }

    result[section.key] = body.slice(contentStart, end).trim();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Extract the ## Notes section from an existing page
// ---------------------------------------------------------------------------

/**
 * Pull the `## Notes` section out of an existing page (operator-controlled
 * territory — preserved verbatim). Accepts null for the new-page path so
 * callers don't have to wrap this in an `if (existing !== null)`.
 *
 * Uses an anchored regex `/^## Notes\s*$/m` to locate the heading — this
 * prevents false matches against `## Notes2`, `## Notesy`, etc. The section
 * end is found by splitting on `/^## /m` and locating the "Notes" entry by
 * exact heading name, so any subsequent `## ` heading (including `## Notes2`)
 * correctly terminates the section.
 */
function extractNotesSection(existingPageContent: string | null): string | null {
  if (existingPageContent === null) return null;

  // Locate the Notes heading with an exact, anchored match.
  const notesHeadingMatch = /^## Notes\s*$/m.exec(existingPageContent);
  if (notesHeadingMatch === null) return null;

  const notesIdx = notesHeadingMatch.index;
  const afterNotes = notesIdx + notesHeadingMatch[0].length;

  // The Notes section runs to the next `## ` heading or end of file.
  // Use an anchored regex so `## ` must start at a line boundary.
  const nextHeadingMatch = /^## /m.exec(existingPageContent.slice(afterNotes));
  const end =
    nextHeadingMatch === null
      ? existingPageContent.length
      : afterNotes + nextHeadingMatch.index;

  return "## Notes\n" + existingPageContent.slice(afterNotes, end);
}

// ---------------------------------------------------------------------------
// Body builder (pure function)
// ---------------------------------------------------------------------------

export interface BuildAsanaProjectBodyArgs {
  readonly snapshot: AsanaProjectSnapshot;
  readonly title: string;
  readonly pagePath: string;
  readonly domainSlug: string;
  readonly compiledAt: Date;
  /**
   * The merged body as returned by the LLM (sections only, no frontmatter).
   * Must contain the four rewritable sections.
   */
  readonly mergedBody: string;
  /**
   * The full existing page content (frontmatter + body), or null for a new page.
   */
  readonly existingPageContent: string | null;
  readonly compiledByRunId?: AgentRunId;
}

/**
 * Assemble the final page body from the LLM's merged output.
 * Throws CompilerValidationError if output exceeds MAX_OUTPUT_CHARS.
 */
export function buildAsanaProjectBody(args: BuildAsanaProjectBodyArgs): string {
  const frontmatter = buildFrontmatter({
    title: args.title,
    pagePath: args.pagePath,
    domainSlug: args.domainSlug,
    compiledAt: args.compiledAt,
    snapshot: args.snapshot,
    ...(args.compiledByRunId !== undefined
      ? { compiledByRunId: args.compiledByRunId }
      : {}),
  });

  // Preserve the operator-controlled ## Notes section from the existing page
  // (returns null for new pages or pages without a Notes section).
  const extractedNotes = extractNotesSection(args.existingPageContent);
  const notesSection =
    extractedNotes !== null ? "\n" + extractedNotes.trimEnd() + "\n" : "";

  // Assemble: frontmatter + "\n" + mergedBody + notesSection
  const body = frontmatter + "\n" + args.mergedBody.trimEnd() + "\n" + notesSection;

  if (body.length > MAX_OUTPUT_CHARS) {
    throw new CompilerValidationError(
      `buildAsanaProjectBody: output exceeds ${MAX_OUTPUT_CHARS} chars (got ${body.length}). Fail-closed per rule 5.`,
    );
  }

  return body;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface CompileAsanaProjectArgs {
  readonly db: Db;
  readonly domainId: DomainId;
  readonly domainSlug: string;
  readonly bindingId: SourceBindingId;
  readonly sourceRef: string;
  readonly snapshot: AsanaProjectSnapshot;
  /** Page title (derived by the caller from the Asana project name). */
  readonly title: string;
  readonly wikiDeps: WikiWriteDeps;
  readonly router: LlmRouter;
  readonly author: WikiAuthor;
  readonly compiledByRunId?: AgentRunId;
  /** Optional clock for compiled_at timestamps; defaults to wall clock. */
  readonly clock?: () => Date;
}

export interface CompileAsanaProjectResult {
  /** The wikiWrite commit sha, or null on a no-op skip-write. */
  readonly commitSha: string | null;
  /** The wiki page path that was (or would have been) written. */
  readonly pagePath: string;
}

export async function compileAsanaProject(
  args: CompileAsanaProjectArgs,
): Promise<CompileAsanaProjectResult> {
  const clock = args.clock ?? ((): Date => new Date());
  const compiledAt = clock();
  const pagePath = asanaProjectPagePath({
    projectGid: args.snapshot.project_gid,
    title: args.title,
  });

  // Read the existing page (may be null for new pages).
  const existing = await args.wikiDeps.adapter.readPage(
    args.domainSlug as DomainSlug,
    pagePath,
  );
  const existingContent = existing?.content ?? null;

  // Build the LLM prompt with XML-spotlighted snapshot data (THREAT-MODEL §3.4).
  const prompt = buildLlmPrompt(args.snapshot, existingContent, args.sourceRef, pagePath);

  // LLM call — Worker tier, per-domain policy enforced by the router.
  const llmResult = await args.router.generateText({
    domainId: args.domainId,
    tier: "worker",
    pipelineOrAgent: "compiler-asana-project",
    prompt,
    documentId: args.sourceRef,
  });

  const mergedBody = llmResult.text;

  // Backstop: merged_body must not contain literal <source_content sentinel
  // (THREAT-MODEL §3.4 backstop — same guard as the document compiler).
  if (mergedBody.includes("<source_content")) {
    throw new CompilerValidationError(
      `compileAsanaProject: mergedBody contains literal <source_content sentinel for ${pagePath}`,
    );
  }
  // Backstop: model must not try to write its own frontmatter.
  if (mergedBody.startsWith("---")) {
    throw new CompilerValidationError(
      `compileAsanaProject: mergedBody for ${pagePath} starts with '---' — model tried to write its own frontmatter`,
    );
  }

  // Assemble the full page body (fails closed if >40k chars).
  const fullBody = buildAsanaProjectBody({
    snapshot: args.snapshot,
    title: args.title,
    pagePath,
    domainSlug: args.domainSlug,
    compiledAt,
    mergedBody,
    existingPageContent: existingContent,
    ...(args.compiledByRunId !== undefined
      ? { compiledByRunId: args.compiledByRunId }
      : {}),
  });

  // Skip-write optimisation: compare body without frontmatter. A regenerated
  // `compiled_at` timestamp in the frontmatter must not trigger a write when
  // the actual content is unchanged.
  const newBodyWithoutFrontmatter = stripFrontmatter(fullBody);
  const existingBodyWithoutFrontmatter =
    existingContent !== null ? stripFrontmatter(existingContent) : null;

  if (
    existingBodyWithoutFrontmatter !== null &&
    newBodyWithoutFrontmatter === existingBodyWithoutFrontmatter
  ) {
    args.wikiDeps.logger.info("compiler.asana_project.no-op", {
      domain_slug: args.domainSlug,
      page_path: pagePath,
      source_ref: args.sourceRef,
    });
    // Even on a no-op, record the citation for audit completeness.
    await tryRecordCitation(args, pagePath);
    return { commitSha: null, pagePath };
  }

  // Atomic wiki write (THREAT-MODEL §2 invariant 2: exactly one wikiWrite).
  const writeInput: WikiWriteInput = {
    domainSlug: args.domainSlug,
    tag: "[compiler]",
    description: `compile ${args.sourceRef} → ${pagePath}`,
    author: args.author,
    caller: { kind: "engine" },
    operations: [
      { mode: "replace", path: pagePath, content: fullBody },
    ],
  };
  const writeResult = await wikiWrite(args.wikiDeps, writeInput);

  await tryRecordCitation(args, pagePath);

  return { commitSha: writeResult.sha, pagePath };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip a leading YAML frontmatter block for skip-write comparison. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return content;
  return content.slice(end + 5);
}

async function tryRecordCitation(
  args: CompileAsanaProjectArgs,
  pagePath: string,
): Promise<void> {
  try {
    await recordPageCitations({
      db: args.db,
      domainSlug: args.domainSlug,
      pagePaths: [pagePath],
      sourceBindingId: args.bindingId,
      sourceRef: args.sourceRef,
      promptVersion: ASANA_PROJECT_PROMPT_VERSION,
      ...(args.compiledByRunId !== undefined
        ? { compiledByRunId: args.compiledByRunId }
        : {}),
    });
  } catch (err) {
    args.wikiDeps.logger.error("compiler.asana_project.page_citations.failed", {
      domain_slug: args.domainSlug,
      page_path: pagePath,
      source_ref: args.sourceRef,
      error: err instanceof Error ? err.message : String(err),
    });
    // Soft-fail — same as the document compiler. The wiki commit
    // landed; reconciliation can backfill missing citations.
  }
}
