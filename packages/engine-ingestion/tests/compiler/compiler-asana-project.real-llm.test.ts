/**
 * compiler-asana-project.real-llm.test.ts — PR-H
 *
 * Real-LLM smoke test for the `content_kind: 'asana-project'`
 * Compiler template. Gated by `RUN_REAL_LLM=1` and requires:
 *   - `OPENROUTER_API_KEY` in the environment (or .env)
 *   - `OPENROUTER_DEFAULT_MODEL` (defaults to 'moonshotai/kimi-k2.6')
 *
 * What this verifies (beyond the mock-LLM unit suite):
 *   - The system prompt and user prompt are well-formed enough for a
 *     real LLM to return a valid markdown body with the four required
 *     sections (## Current state / ## Open tasks / ## Recent activity
 *     / ## Risks).
 *   - The compiled output does NOT contain literal `<source_content`
 *     (backstop sentinel check).
 *   - The compiled output is ≤40k chars (size cap).
 *   - The ## Notes section from an existing page is preserved verbatim
 *     in the real-LLM output.
 *   - The `page_citations` row is written with the correct
 *     `prompt_version: 'asana-project:1.0'`.
 *
 * Usage:
 *   RUN_REAL_LLM=1 pnpm --filter @opencoo/engine-ingestion test compiler-asana-project.real-llm
 */

import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../../..");

// Load .env from repo root (non-throwing — CI may not have the file).
dotenv.config({ path: path.resolve(REPO_ROOT, ".env") });

import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  LlmRouter,
  InMemoryQueuePauser,
  createOpenRouterProvider,
} from "@opencoo/shared/llm-router";

import {
  ASANA_PROJECT_PROMPT_VERSION,
  compileAsanaProject,
  parseAsanaProjectSections,
  asanaProjectPagePath,
  type AsanaProjectSnapshot,
} from "../../src/compiler/asana-project.js";

import { freshCompilerDb } from "./_pglite-fixture.js";

const RUN_REAL_LLM = process.env["RUN_REAL_LLM"] === "1";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const COMPILER_AUTHOR = {
  name: "opencoo-compiler",
  email: "compiler@opencoo.local",
} as const;

function makeSnapshot(): AsanaProjectSnapshot {
  return {
    project_gid: "1234567890",
    snapshot: [
      {
        gid: "task-1",
        name: "Prepare Q2 strategy deck",
        assignee: { name: "Anna Kowalska" },
        completed: false,
        due_on: "2026-05-15",
        modified_at: "2026-05-01T10:00:00.000Z",
        memberships: [{ section: { name: "In Progress" } }],
      },
      {
        gid: "task-2",
        name: "Send onboarding email to client",
        assignee: { name: "Piotr Nowak" },
        completed: true,
        due_on: null,
        modified_at: "2026-04-28T09:00:00.000Z",
        memberships: [{ section: { name: "Done" } }],
      },
      {
        gid: "task-3",
        name: "Review risk register",
        assignee: null,
        completed: false,
        due_on: "2026-04-10", // overdue
        modified_at: "2026-04-10T08:00:00.000Z",
        memberships: [{ section: { name: "Blocked" } }],
      },
      {
        gid: "task-4",
        name: "Schedule kick-off call",
        assignee: { name: "Anna Kowalska" },
        completed: false,
        due_on: "2026-05-20",
        modified_at: "2026-04-30T14:00:00.000Z",
        memberships: [{ section: { name: "Upcoming" } }],
      },
    ],
    incomplete_count: 3,
    overdue_count: 1,
    fetched_at: "2026-05-02T10:00:00.000Z",
  };
}

const EXISTING_NOTES = "These are operator notes preserved across LLM rewrites.";

function makeExistingPage(): string {
  return `---
title: "Test Real-LLM Campaign"
type: asana-project
last_updated: "2026-04-01T00:00:00.000Z"
asana_project_gid: "1234567890"
status: active
schema_version: "1.0.0"
compiled_at: "2026-04-01T00:00:00.000Z"
prompt_version: "${ASANA_PROJECT_PROMPT_VERSION}"
domain_slug: "ops"
page_path: "projects/test-real-llm-campaign-1234567890.md"
compiled_by_run_id: null
---

## Current state

Old current state.

## Open tasks

- Old task.

## Recent activity

- Old activity.

## Risks

Old risks.

## Notes

${EXISTING_NOTES}
`;
}

describe.skipIf(!RUN_REAL_LLM)("compileAsanaProject — real-LLM (RUN_REAL_LLM=1)", () => {
  let router: LlmRouter;
  let f: Awaited<ReturnType<typeof freshCompilerDb>>;

  beforeAll(async () => {
    const apiKey = process.env["OPENROUTER_API_KEY"];
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for real-LLM tests");

    const model =
      process.env["OPENROUTER_DEFAULT_MODEL"] ?? "moonshotai/kimi-k2.6";

    const provider = await createOpenRouterProvider({ apiKey });

    // Override the FALLBACK_POLICY's worker model to use the OpenRouter model.
    // We patch the domain's llm_policy via the DB after freshCompilerDb seeds it.
    f = await freshCompilerDb();

    const policy = {
      thinker: { provider: "openai", model },
      worker: { provider: "openai", model },
      light: { provider: "openai", model },
      local_only: false,
    };
    await f.db.execute(sql`
      UPDATE domains SET llm_policy = ${JSON.stringify(policy)}::jsonb WHERE id = ${f.domainId}::uuid
    `);

    router = new LlmRouter({
      db: f.db as unknown as Parameters<typeof LlmRouter.prototype.generateText>[0],
      env: process.env,
      logger: silentLogger(),
      pauser: new InMemoryQueuePauser(),
      provider,
    });
  });

  it("compiles a page with all four required sections", async () => {
    const snapshot = makeSnapshot();
    const wikiAdapter = new InMemoryWikiAdapter();
    const wikiDeps: WikiWriteDeps = {
      adapter: wikiAdapter,
      queue: new InMemoryWikiWriteQueue(),
      deleteCap: new InMemoryDeleteCap(),
      logger: silentLogger(),
      clock: () => new Date("2026-05-02T10:00:00Z"),
      instanceId: "test",
    };

    const result = await compileAsanaProject({
      db: f.db as unknown as Parameters<typeof compileAsanaProject>[0]["db"],
      domainId: f.domainId as Parameters<typeof compileAsanaProject>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compileAsanaProject>[0]["bindingId"],
      sourceRef: `asana:project:${snapshot.project_gid}`,
      snapshot,
      title: "Test Real-LLM Campaign",
      wikiDeps,
      router,
      author: COMPILER_AUTHOR,
    });

    expect(result.commitSha).not.toBeNull();

    const page = await wikiAdapter.readPage("test-domain", result.pagePath);
    expect(page).not.toBeNull();

    const content = page!.content;

    // All four required sections must be present
    expect(content).toContain("## Current state");
    expect(content).toContain("## Open tasks");
    expect(content).toContain("## Recent activity");
    expect(content).toContain("## Risks");

    // Backstop: no sentinel leakage
    expect(content).not.toContain("<source_content");

    // Size cap
    expect(content.length).toBeLessThanOrEqual(40_000);

    // Sections must have real content
    const sections = parseAsanaProjectSections(content);
    expect(sections.currentState.trim().length).toBeGreaterThan(0);
    expect(sections.openTasks.trim().length).toBeGreaterThan(0);
  }, 60_000);

  it("preserves ## Notes section verbatim from an existing page", async () => {
    const snapshot = makeSnapshot();
    const wikiAdapter = new InMemoryWikiAdapter();

    // Pre-seed the wiki with an existing page that has a ## Notes section
    const existingContent = makeExistingPage();
    const pagePath = asanaProjectPagePath({
      projectGid: snapshot.project_gid,
      title: "Test Real-LLM Campaign",
    });
    // Write the existing page directly to the adapter
    await wikiAdapter.writeAtomic({
      domainSlug: "test-domain",
      tag: "[compiler]",
      message: "seed existing page",
      author: COMPILER_AUTHOR,
      operations: [{ mode: "replace", path: pagePath, content: existingContent }],
    });

    const wikiDeps: WikiWriteDeps = {
      adapter: wikiAdapter,
      queue: new InMemoryWikiWriteQueue(),
      deleteCap: new InMemoryDeleteCap(),
      logger: silentLogger(),
      clock: () => new Date("2026-05-02T10:00:00Z"),
      instanceId: "test",
    };

    const result = await compileAsanaProject({
      db: f.db as unknown as Parameters<typeof compileAsanaProject>[0]["db"],
      domainId: f.domainId as Parameters<typeof compileAsanaProject>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compileAsanaProject>[0]["bindingId"],
      sourceRef: `asana:project:${snapshot.project_gid}`,
      snapshot,
      title: "Test Real-LLM Campaign",
      wikiDeps,
      router,
      author: COMPILER_AUTHOR,
    });

    const page = await wikiAdapter.readPage("test-domain", result.pagePath);
    expect(page).not.toBeNull();
    expect(page!.content).toContain("## Notes");
    expect(page!.content).toContain(EXISTING_NOTES);
  }, 60_000);

  it("records a page_citations row with correct prompt_version", async () => {
    const snapshot = makeSnapshot();
    const wikiAdapter = new InMemoryWikiAdapter();
    const wikiDeps: WikiWriteDeps = {
      adapter: wikiAdapter,
      queue: new InMemoryWikiWriteQueue(),
      deleteCap: new InMemoryDeleteCap(),
      logger: silentLogger(),
      clock: () => new Date("2026-05-02T10:00:00Z"),
      instanceId: "test",
    };

    await compileAsanaProject({
      db: f.db as unknown as Parameters<typeof compileAsanaProject>[0]["db"],
      domainId: f.domainId as Parameters<typeof compileAsanaProject>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compileAsanaProject>[0]["bindingId"],
      sourceRef: `asana:project:${snapshot.project_gid}`,
      snapshot,
      title: "Test Real-LLM Campaign",
      wikiDeps,
      router,
      author: COMPILER_AUTHOR,
    });

    const rows = (await f.db.execute(
      sql`SELECT prompt_version, source_ref FROM page_citations`,
    )) as unknown as { rows: Array<{ prompt_version: string; source_ref: string }> };
    // At least one row with the correct prompt_version
    const row = rows.rows.find(
      (r) => r.prompt_version === ASANA_PROJECT_PROMPT_VERSION,
    );
    expect(row).toBeDefined();
    expect(row?.source_ref).toBe(`asana:project:${snapshot.project_gid}`);
  }, 60_000);
});
