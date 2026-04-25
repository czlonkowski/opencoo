/**
 * `recordPageCitations` — append-only writer for the
 * `page_citations` table. Called by the compiler AFTER a
 * successful wikiWrite commit, so a soft failure here logs +
 * alerts but does not unwind the wiki commit.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { pageCitations } from "@opencoo/shared/db/schema";

import { recordPageCitations } from "../../src/compiler/page-citations.js";

import { freshCompilerDb } from "./_pglite-fixture.js";

describe("recordPageCitations — append", () => {
  it("inserts one row per (domainSlug, pagePath) pair", async () => {
    const { db, bindingId } = await freshCompilerDb();
    await recordPageCitations({
      db,
      domainSlug: "test-domain",
      sourceBindingId: bindingId as Parameters<
        typeof recordPageCitations
      >[0]["sourceBindingId"],
      sourceRef: "drive:doc-1",
      promptVersion: "1.0.0",
      pagePaths: ["strategy/q3.md", "executive/intro.md"],
    });
    const rows = await db
      .select()
      .from(pageCitations)
      .where(eq(pageCitations.domainSlug, "test-domain"));
    expect(rows).toHaveLength(2);
    const paths = rows.map((r) => r.pagePath).sort();
    expect(paths).toEqual(["executive/intro.md", "strategy/q3.md"]);
  });

  it("populates source_ref + prompt_version on every row", async () => {
    const { db, bindingId } = await freshCompilerDb();
    await recordPageCitations({
      db,
      domainSlug: "test-domain",
      sourceBindingId: bindingId as Parameters<
        typeof recordPageCitations
      >[0]["sourceBindingId"],
      sourceRef: "drive:doc-1",
      promptVersion: "1.0.0",
      pagePaths: ["strategy/q3.md"],
    });
    const row = (
      await db.select().from(pageCitations)
    )[0];
    expect(row?.sourceRef).toBe("drive:doc-1");
    expect(row?.promptVersion).toBe("1.0.0");
  });

  it("writes compiledByRunId when provided", async () => {
    const { db, bindingId } = await freshCompilerDb();
    // Seed an agent_run row so the FK is satisfied.
    const runResult = await db.execute(
      `INSERT INTO agent_runs (definition_slug, trigger, status) VALUES ('compiler', 'pipeline', 'running') RETURNING id`,
    );
    const runId = (runResult.rows[0] as { id: string }).id;
    await recordPageCitations({
      db,
      domainSlug: "test-domain",
      sourceBindingId: bindingId as Parameters<
        typeof recordPageCitations
      >[0]["sourceBindingId"],
      sourceRef: "drive:doc-1",
      promptVersion: "1.0.0",
      pagePaths: ["strategy/q3.md"],
      compiledByRunId: runId as Parameters<
        typeof recordPageCitations
      >[0]["compiledByRunId"],
    });
    const row = (
      await db.select().from(pageCitations)
    )[0];
    expect(row?.compiledByRunId).toBe(runId);
  });

  it("noop on empty pagePaths (caller's compiler may legitimately compile 0 pages on a no-op)", async () => {
    const { db, bindingId } = await freshCompilerDb();
    await recordPageCitations({
      db,
      domainSlug: "test-domain",
      sourceBindingId: bindingId as Parameters<
        typeof recordPageCitations
      >[0]["sourceBindingId"],
      sourceRef: "drive:doc-1",
      promptVersion: "1.0.0",
      pagePaths: [],
    });
    const rows = await db.select().from(pageCitations);
    expect(rows).toHaveLength(0);
  });
});
