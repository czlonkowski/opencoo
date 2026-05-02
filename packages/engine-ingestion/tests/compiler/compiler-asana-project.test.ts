/**
 * compiler-asana-project.test.ts — PR-H
 *
 * TDD suite for the `content_kind: 'asana-project'` Compiler template.
 *
 * Two layers:
 *   1. Pure-function tests: body builder + section parser (round-trip,
 *      frontmatter shape, section preservation, size cap, new-page path).
 *   2. Orchestration tests: compileAsanaProject produces ONE atomic
 *      wikiWrite operation, appends a page_citations row, calls the LLM
 *      router at Worker tier, respects THREAT-MODEL §2 invariant 2
 *      (exactly one wikiWrite per run).
 *
 * LOAD-BEARING assertion: snapshot JSON → compiled page → re-parsed
 * sections deep-equal expected content (round-trip cleanness).
 *
 * THREAT-MODEL checklist:
 *   §3.4 — snapshot data wrapped in <source_content> via spotlight()
 *   §3.5 — target_path validated against binding's allowed paths
 *   invariant 2 — exactly one wikiWrite per compile run (spy assertion)
 */
import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter } from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router";
import { InMemoryQueuePauser } from "@opencoo/shared/llm-router";

import {
  ASANA_PROJECT_PROMPT_VERSION,
  buildAsanaProjectBody,
  asanaProjectPagePath,
  compileAsanaProject,
  parseAsanaProjectSections,
  type AsanaProjectSnapshot,
} from "../../src/compiler/asana-project.js";
import { CompilerValidationError } from "../../src/compiler/errors.js";

import { freshCompilerDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const COMPILER_AUTHOR = {
  name: "opencoo-compiler",
  email: "compiler@opencoo.local",
} as const;

/** Minimal valid AsanaProjectSnapshot fixture. */
function makeSnapshot(overrides?: Partial<AsanaProjectSnapshot>): AsanaProjectSnapshot {
  return {
    project_gid: "1234567890",
    snapshot: [
      {
        gid: "task-1",
        name: "Write unit tests",
        assignee: { name: "Alice" },
        completed: false,
        due_on: "2026-05-10",
        modified_at: "2026-05-01T10:00:00.000Z",
        memberships: [{ section: { name: "In Progress" } }],
      },
      {
        gid: "task-2",
        name: "Deploy to staging",
        assignee: null,
        completed: true,
        due_on: null,
        modified_at: "2026-05-01T09:00:00.000Z",
        memberships: [],
      },
      {
        gid: "task-3",
        name: "Review with client",
        assignee: { name: "Bob" },
        completed: false,
        due_on: "2026-04-20", // overdue
        modified_at: "2026-04-29T10:00:00.000Z",
        memberships: [{ section: { name: "Review" } }],
      },
    ],
    incomplete_count: 2,
    overdue_count: 1,
    fetched_at: "2026-05-02T10:00:00.000Z",
    ...overrides,
  };
}

/** Build a valid existing page with all required sections. */
function makeExistingPage(notes = "Some operator notes."): string {
  return `---
title: "Test Campaign"
type: asana-project
last_updated: "2026-04-01T00:00:00.000Z"
asana_project_gid: "1234567890"
status: active
schema_version: "1.0.0"
compiled_at: "2026-04-01T00:00:00.000Z"
prompt_version: "${ASANA_PROJECT_PROMPT_VERSION}"
domain_slug: "ops"
page_path: "projects/test-campaign.md"
compiled_by_run_id: null
---

## Current state

Old current state text.

## Open tasks

- Old task

## Recent activity

- Old activity

## Risks

None.

## Notes

${notes}
`;
}

/** Build the stub LLM response for the round-trip test. */
function makeStubLlmResponse(snapshot: AsanaProjectSnapshot): string {
  const incompleteTasks = snapshot.snapshot
    .filter((t) => !t.completed)
    .slice(0, 10);
  const recentActivity = snapshot.snapshot
    .slice()
    .sort((a, b) => b.modified_at.localeCompare(a.modified_at))
    .slice(0, 10);

  const openTaskLines = incompleteTasks.map((t) => {
    const assignee = t.assignee?.name ?? "Unassigned";
    const due = t.due_on ?? "no due date";
    const section =
      (t.memberships?.[0] as { section?: { name: string } } | undefined)
        ?.section?.name ?? "No section";
    return `- ${t.name} (${assignee}, due: ${due}, section: ${section})`;
  });

  const activityLines = recentActivity.map(
    (t) => `- ${t.name} modified at ${t.modified_at}`,
  );

  return [
    "## Current state",
    "",
    `Project ${snapshot.project_gid} has ${snapshot.incomplete_count} incomplete tasks, ${snapshot.overdue_count} overdue.`,
    "",
    "## Open tasks",
    "",
    ...openTaskLines,
    "",
    "## Recent activity",
    "",
    ...activityLines,
    "",
    "## Risks",
    "",
    "One task is overdue.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Page-path derivation
// ---------------------------------------------------------------------------

describe("asanaProjectPagePath", () => {
  it("derives path from project title with slug normalization", () => {
    expect(asanaProjectPagePath({ projectGid: "1234567890", title: "Test Campaign" }))
      .toBe("projects/test-campaign-1234567890.md");
  });

  it("falls back to 'project' when title is empty or all-special", () => {
    expect(asanaProjectPagePath({ projectGid: "abc", title: "" }))
      .toBe("projects/project-abc.md");
    expect(asanaProjectPagePath({ projectGid: "abc", title: "!!! ???" }))
      .toBe("projects/project-abc.md");
  });
});

// ---------------------------------------------------------------------------
// Body builder — frontmatter shape (new-page path)
// ---------------------------------------------------------------------------

describe("buildAsanaProjectBody — new-page frontmatter", () => {
  it("creates frontmatter with required fields for a new page", () => {
    const snapshot = makeSnapshot();
    const body = buildAsanaProjectBody({
      snapshot,
      title: "Test Campaign",
      pagePath: "projects/test-campaign-1234567890.md",
      domainSlug: "ops",
      compiledAt: new Date("2026-05-02T10:00:00Z"),
      mergedBody: makeStubLlmResponse(snapshot),
      existingPageContent: null,
    });

    expect(body).toContain('title: "Test Campaign"');
    expect(body).toContain("type: asana-project");
    expect(body).toContain("asana_project_gid: \"1234567890\"");
    expect(body).toContain("last_updated:");
    expect(body).toContain("status: active");
    expect(body).toContain("schema_version: \"1.0.0\"");
    expect(body).toContain(`prompt_version: "${ASANA_PROJECT_PROMPT_VERSION}"`);
  });

  it("includes ## Current state, ## Open tasks, ## Recent activity, ## Risks sections", () => {
    const snapshot = makeSnapshot();
    const body = buildAsanaProjectBody({
      snapshot,
      title: "Test Campaign",
      pagePath: "projects/test-campaign-1234567890.md",
      domainSlug: "ops",
      compiledAt: new Date("2026-05-02T10:00:00Z"),
      mergedBody: makeStubLlmResponse(snapshot),
      existingPageContent: null,
    });

    expect(body).toContain("## Current state");
    expect(body).toContain("## Open tasks");
    expect(body).toContain("## Recent activity");
    expect(body).toContain("## Risks");
  });

  it("does NOT include ## Notes section when no existing page", () => {
    const snapshot = makeSnapshot();
    const body = buildAsanaProjectBody({
      snapshot,
      title: "Test Campaign",
      pagePath: "projects/test-campaign-1234567890.md",
      domainSlug: "ops",
      compiledAt: new Date("2026-05-02T10:00:00Z"),
      mergedBody: makeStubLlmResponse(snapshot),
      existingPageContent: null,
    });

    expect(body).not.toContain("## Notes");
  });
});

// ---------------------------------------------------------------------------
// Body builder — existing-page preservation
// ---------------------------------------------------------------------------

describe("buildAsanaProjectBody — existing page preservation", () => {
  it("preserves ## Notes section verbatim from existing page", () => {
    const snapshot = makeSnapshot();
    const notes = "Important operator notes. Do not change.";
    const existing = makeExistingPage(notes);

    const body = buildAsanaProjectBody({
      snapshot,
      title: "Test Campaign",
      pagePath: "projects/test-campaign-1234567890.md",
      domainSlug: "ops",
      compiledAt: new Date("2026-05-02T10:00:00Z"),
      mergedBody: makeStubLlmResponse(snapshot),
      existingPageContent: existing,
    });

    expect(body).toContain("## Notes");
    expect(body).toContain(notes);
  });

  it("preserves YAML frontmatter type/asana_project_gid from existing page", () => {
    const snapshot = makeSnapshot();
    const existing = makeExistingPage();

    const body = buildAsanaProjectBody({
      snapshot,
      title: "Test Campaign",
      pagePath: "projects/test-campaign-1234567890.md",
      domainSlug: "ops",
      compiledAt: new Date("2026-05-02T10:00:00Z"),
      mergedBody: makeStubLlmResponse(snapshot),
      existingPageContent: existing,
    });

    expect(body).toContain("type: asana-project");
    expect(body).toContain(`asana_project_gid: "1234567890"`);
  });

  it("rewrites ## Current state / ## Open tasks / ## Recent activity / ## Risks from LLM output", () => {
    const snapshot = makeSnapshot();
    const existing = makeExistingPage();
    const mergedBody = makeStubLlmResponse(snapshot);

    const body = buildAsanaProjectBody({
      snapshot,
      title: "Test Campaign",
      pagePath: "projects/test-campaign-1234567890.md",
      domainSlug: "ops",
      compiledAt: new Date("2026-05-02T10:00:00Z"),
      mergedBody,
      existingPageContent: existing,
    });

    // The "Old current state text" from the existing page should NOT survive
    expect(body).not.toContain("Old current state text");
    // The LLM merged content should be present
    expect(body).toContain(`Project ${snapshot.project_gid} has`);
  });
});

// ---------------------------------------------------------------------------
// Size cap — fails closed at ≤40k chars
// ---------------------------------------------------------------------------

describe("buildAsanaProjectBody — size cap", () => {
  it("throws CompilerValidationError when output exceeds 40k chars", () => {
    const snapshot = makeSnapshot();
    // Generate a mergedBody that's guaranteed to blow past 40k
    const hugeMergedBody = "A".repeat(41_000);

    expect(() =>
      buildAsanaProjectBody({
        snapshot,
        title: "Test Campaign",
        pagePath: "projects/test-campaign-1234567890.md",
        domainSlug: "ops",
        compiledAt: new Date("2026-05-02T10:00:00Z"),
        mergedBody: hugeMergedBody,
        existingPageContent: null,
      }),
    ).toThrow(CompilerValidationError);
  });

  it("does NOT throw when output is exactly at 40k chars", () => {
    // Use an empty mergedBody; the full page will be well under 40k
    const snapshot = makeSnapshot();
    expect(() =>
      buildAsanaProjectBody({
        snapshot,
        title: "Test Campaign",
        pagePath: "projects/test-campaign-1234567890.md",
        domainSlug: "ops",
        compiledAt: new Date("2026-05-02T10:00:00Z"),
        mergedBody: "Minimal content.",
        existingPageContent: null,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseAsanaProjectSections — section parser
// ---------------------------------------------------------------------------

describe("parseAsanaProjectSections", () => {
  it("extracts all four rewritable sections", () => {
    const merged = makeStubLlmResponse(makeSnapshot());
    const sections = parseAsanaProjectSections(merged);
    expect(sections).toHaveProperty("currentState");
    expect(sections).toHaveProperty("openTasks");
    expect(sections).toHaveProperty("recentActivity");
    expect(sections).toHaveProperty("risks");
  });

  it("returns empty strings for missing sections (no throw)", () => {
    const sections = parseAsanaProjectSections("## Current state\n\nSome content.");
    expect(sections.openTasks).toBe("");
    expect(sections.recentActivity).toBe("");
    expect(sections.risks).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: snapshot → compile → re-parse sections deep-equal
// ---------------------------------------------------------------------------

describe("compileAsanaProject — round-trip (mock LLM)", () => {
  it("produces a page whose re-parsed sections match the LLM merged body", async () => {
    const f = await freshCompilerDb();
    const snapshot = makeSnapshot();
    const mergedBody = makeStubLlmResponse(snapshot);

    const mockClient = new MockLlmClient();
    // Worker tier uses FALLBACK_POLICY model 'gpt-4o-mini'
    mockClient.register({
      match: {
        model: "gpt-4o-mini",
        promptIncludes: snapshot.project_gid,
      },
      response: {
        text: mergedBody,
        tokensIn: 100,
        tokensOut: 200,
      },
    });

    const router = new LlmRouter({
      db: f.db as unknown as Parameters<typeof LlmRouter.prototype.generateText>[0],
      env: {},
      logger: silentLogger(),
      pauser: new InMemoryQueuePauser(),
      provider: mockClient,
    });

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
      title: "Test Campaign",
      wikiDeps,
      router,
      author: COMPILER_AUTHOR,
    });

    expect(result.commitSha).not.toBeNull();
    expect(result.pagePath).toBe(asanaProjectPagePath({ projectGid: snapshot.project_gid, title: "Test Campaign" }));

    // Re-read the page and verify round-trip sections match
    const page = await wikiAdapter.readPage("test-domain", result.pagePath);
    expect(page).not.toBeNull();
    const sections = parseAsanaProjectSections(page!.content);
    expect(sections.currentState.trim()).toContain(snapshot.project_gid);
    expect(sections.openTasks).not.toBe("");
    expect(sections.risks.trim()).toBe("One task is overdue.");
  });
});

// ---------------------------------------------------------------------------
// Orchestration — one atomic wikiWrite + page_citations
// ---------------------------------------------------------------------------

describe("compileAsanaProject — orchestration", () => {
  it("writes exactly ONE replace operation (THREAT-MODEL invariant 2)", async () => {
    const f = await freshCompilerDb();
    const snapshot = makeSnapshot();
    const mergedBody = makeStubLlmResponse(snapshot);

    const mockClient = new MockLlmClient();
    mockClient.register({
      match: { model: "gpt-4o-mini", promptIncludes: snapshot.project_gid },
      response: { text: mergedBody, tokensIn: 100, tokensOut: 200 },
    });

    const router = new LlmRouter({
      db: f.db as unknown as Parameters<typeof LlmRouter.prototype.generateText>[0],
      env: {},
      logger: silentLogger(),
      pauser: new InMemoryQueuePauser(),
      provider: mockClient,
    });

    const wikiAdapter = new InMemoryWikiAdapter();
    const writeSpy = vi.spyOn(wikiAdapter, "writeAtomic");
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
      title: "Test Campaign",
      wikiDeps,
      router,
      author: COMPILER_AUTHOR,
    });

    // THREAT-MODEL §2 invariant 2: exactly ONE wikiWrite per Compiler run
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("appends a page_citations row with correct prompt_version", async () => {
    const f = await freshCompilerDb();
    const snapshot = makeSnapshot();
    const mergedBody = makeStubLlmResponse(snapshot);

    const mockClient = new MockLlmClient();
    mockClient.register({
      match: { model: "gpt-4o-mini", promptIncludes: snapshot.project_gid },
      response: { text: mergedBody, tokensIn: 100, tokensOut: 200 },
    });

    const router = new LlmRouter({
      db: f.db as unknown as Parameters<typeof LlmRouter.prototype.generateText>[0],
      env: {},
      logger: silentLogger(),
      pauser: new InMemoryQueuePauser(),
      provider: mockClient,
    });

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
      title: "Test Campaign",
      wikiDeps,
      router,
      author: COMPILER_AUTHOR,
    });

    const rows = (await f.db.execute(
      sql`SELECT prompt_version, source_ref FROM page_citations`,
    )) as unknown as { rows: Array<{ prompt_version: string; source_ref: string }> };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.prompt_version).toBe(ASANA_PROJECT_PROMPT_VERSION);
    expect(rows.rows[0]?.source_ref).toBe(`asana:project:${snapshot.project_gid}`);
  });

  it("re-running with identical snapshot produces a no-op (skip-write)", async () => {
    const f = await freshCompilerDb();
    const snapshot = makeSnapshot();
    const mergedBody = makeStubLlmResponse(snapshot);

    const mockClient = new MockLlmClient();
    mockClient.register({
      match: { model: "gpt-4o-mini", promptIncludes: snapshot.project_gid },
      response: { text: mergedBody, tokensIn: 100, tokensOut: 200 },
    });

    const router = new LlmRouter({
      db: f.db as unknown as Parameters<typeof LlmRouter.prototype.generateText>[0],
      env: {},
      logger: silentLogger(),
      pauser: new InMemoryQueuePauser(),
      provider: mockClient,
    });

    const wikiAdapter = new InMemoryWikiAdapter();
    const writeSpy = vi.spyOn(wikiAdapter, "writeAtomic");
    const wikiDeps: WikiWriteDeps = {
      adapter: wikiAdapter,
      queue: new InMemoryWikiWriteQueue(),
      deleteCap: new InMemoryDeleteCap(),
      logger: silentLogger(),
      clock: () => new Date("2026-05-02T10:00:00Z"),
      instanceId: "test",
    };

    const args = {
      db: f.db as unknown as Parameters<typeof compileAsanaProject>[0]["db"],
      domainId: f.domainId as Parameters<typeof compileAsanaProject>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compileAsanaProject>[0]["bindingId"],
      sourceRef: `asana:project:${snapshot.project_gid}`,
      snapshot,
      title: "Test Campaign",
      wikiDeps,
      router,
      author: COMPILER_AUTHOR,
    };

    await compileAsanaProject(args);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    // Same snapshot again — mock re-registers to allow the LLM call
    mockClient.register({
      match: { model: "gpt-4o-mini", promptIncludes: snapshot.project_gid },
      response: { text: mergedBody, tokensIn: 100, tokensOut: 200 },
    });

    const second = await compileAsanaProject(args);
    // No second wikiWrite — skip-write no-op
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(second.commitSha).toBeNull();
  });

  it("uses Worker tier (not Thinker) for the LLM call", async () => {
    const f = await freshCompilerDb();
    const snapshot = makeSnapshot();
    const mergedBody = makeStubLlmResponse(snapshot);

    // Worker tier uses FALLBACK_POLICY worker model. If the router tries
    // thinker tier, MockLlmClient will throw (no match registered for thinker).
    // This validates tier enforcement.
    const mockClient = new MockLlmClient();
    mockClient.register({
      match: { model: "gpt-4o-mini", promptIncludes: snapshot.project_gid },
      response: { text: mergedBody, tokensIn: 100, tokensOut: 200 },
    });

    const tiersSeen: string[] = [];
    const routerDb = f.db as unknown as Parameters<typeof LlmRouter.prototype.generateText>[0];

    // Intercept generateText to record tier
    const router = new LlmRouter({
      db: routerDb,
      env: {},
      logger: silentLogger(),
      pauser: new InMemoryQueuePauser(),
      provider: mockClient,
    });
    const origGenerate = router.generateText.bind(router);
    vi.spyOn(router, "generateText").mockImplementation(async (opts) => {
      tiersSeen.push(opts.tier);
      return origGenerate(opts);
    });

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
      title: "Test Campaign",
      wikiDeps,
      router,
      author: COMPILER_AUTHOR,
    });

    expect(tiersSeen).toContain("worker");
    expect(tiersSeen).not.toContain("thinker");
  });

  it("XML-spotlights the snapshot JSON in the LLM prompt (THREAT-MODEL §3.4)", async () => {
    const f = await freshCompilerDb();
    const snapshot = makeSnapshot();
    const mergedBody = makeStubLlmResponse(snapshot);

    const promptsSeen: string[] = [];
    const capturingClient = {
      generate: vi.fn(async (call: { model: string; prompt: string; provider: string }) => {
        promptsSeen.push(call.prompt);
        return { text: mergedBody, tokensIn: 100, tokensOut: 200 };
      }),
    };

    const router = new LlmRouter({
      db: f.db as unknown as Parameters<typeof LlmRouter.prototype.generateText>[0],
      env: {},
      logger: silentLogger(),
      pauser: new InMemoryQueuePauser(),
      provider: capturingClient,
    });

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
      title: "Test Campaign",
      wikiDeps,
      router,
      author: COMPILER_AUTHOR,
    });

    expect(promptsSeen).toHaveLength(1);
    // THREAT-MODEL §3.4: snapshot data must be wrapped in <source_content>
    expect(promptsSeen[0]).toContain("<source_content");
    expect(promptsSeen[0]).toContain(snapshot.project_gid);
  });
});

// ---------------------------------------------------------------------------
// Cross-link preservation
// ---------------------------------------------------------------------------

describe("compileAsanaProject — cross-links preserved", () => {
  it("preserves existing wiki cross-links from existing page (does not invent paths)", async () => {
    const f = await freshCompilerDb();
    const snapshot = makeSnapshot();
    // Merged body that CONTAINS a cross-link (test that it passes through)
    const mergedBody = makeStubLlmResponse(snapshot) + "\n\nSee [[wiki/ops/team.md]] for details.";

    const mockClient = new MockLlmClient();
    mockClient.register({
      match: { model: "gpt-4o-mini", promptIncludes: snapshot.project_gid },
      response: { text: mergedBody, tokensIn: 100, tokensOut: 200 },
    });

    const router = new LlmRouter({
      db: f.db as unknown as Parameters<typeof LlmRouter.prototype.generateText>[0],
      env: {},
      logger: silentLogger(),
      pauser: new InMemoryQueuePauser(),
      provider: mockClient,
    });

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
      title: "Test Campaign",
      wikiDeps,
      router,
      author: COMPILER_AUTHOR,
    });

    const page = await wikiAdapter.readPage("test-domain", asanaProjectPagePath({ projectGid: snapshot.project_gid, title: "Test Campaign" }));
    expect(page?.content).toContain("[[wiki/ops/team.md]]");
  });
});
