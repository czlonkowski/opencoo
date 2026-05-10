/**
 * Forget consumer — recompile worker (PR-W6, phase-a appendix #11
 * follow-up #65).
 *
 * Pinned behaviors:
 *   1. Job processed → forgotten binding's page_citations rows are
 *      DELETED + the injected `recompilePage` hook is called with
 *      the remaining citations as input.
 *   2. Page with ONLY citations from the forgotten binding → hook
 *      NOT called (the companion delete_page job handles the page).
 *      No db DELETE either — the delete worker owns the cascade
 *      prune for the page-removal path.
 *   3. Page with no recorded citations at all → no-op + warn (race
 *      between forget-plan and consume).
 *   4. Hook throws → handler re-throws so BullMQ retries.
 */
import type { Job } from "bullmq";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import type { ForgetJobPayload } from "@opencoo/shared/forget";

import {
  buildForgetRecompileHandler,
  type ForgetRecompileDeps,
  type RecompilePageHook,
  type RemainingCitation,
} from "../../src/workers/forget-consumer.js";

import { freshPipelineDb } from "../pipelines/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

function fakeJob(data: ForgetJobPayload): Job<ForgetJobPayload> {
  return {
    id: "job-1",
    name: "recompile_page",
    data,
    queueName: "wiki.recompile",
    attemptsMade: 0,
    timestamp: Date.now(),
  } as unknown as Job<ForgetJobPayload>;
}

/** Insert a `page_citations` row directly via the test fixture's
 *  raw client. The fixture seeds one binding by default; tests that
 *  need additional bindings insert via SQL. */
async function insertCitation(
  raw: import("@electric-sql/pglite").PGlite,
  args: {
    domainSlug: string;
    pagePath: string;
    sourceBindingId: string;
    sourceRef: string;
  },
): Promise<void> {
  await raw.query(
    `INSERT INTO page_citations
       (domain_slug, page_path, source_binding_id, source_ref, prompt_version)
     VALUES ($1, $2, $3::uuid, $4, $5)`,
    [
      args.domainSlug,
      args.pagePath,
      args.sourceBindingId,
      args.sourceRef,
      "compiler@v1",
    ],
  );
}

async function insertExtraBinding(
  raw: import("@electric-sql/pglite").PGlite,
  domainId: string,
  adapterSlug: string,
): Promise<string> {
  const result = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, allowed_paths)
     VALUES ($1, $2, $3) RETURNING id`,
    [domainId, adapterSlug, ["strategy/**"]],
  );
  return result.rows[0]!.id;
}

interface SpyRecord {
  readonly bindingId: string;
  readonly domainSlug: string;
  readonly pagePath: string;
  readonly callerUsername: string;
  readonly remainingCitations: readonly RemainingCitation[];
}

function makeSpyHook(): {
  hook: RecompilePageHook;
  calls: SpyRecord[];
} {
  const calls: SpyRecord[] = [];
  const hook: RecompilePageHook = async (args) => {
    calls.push({
      bindingId: args.bindingId,
      domainSlug: args.domainSlug,
      pagePath: args.pagePath,
      callerUsername: args.callerUsername,
      remainingCitations: args.remainingCitations,
    });
  };
  return { hook, calls };
}

describe("buildForgetRecompileHandler", () => {
  it("drops the forgotten binding's citations + recompiles with the remaining 2", async () => {
    const fixture = await freshPipelineDb();
    const otherBindingA = await insertExtraBinding(
      fixture.raw,
      fixture.domainId,
      "asana",
    );
    const otherBindingB = await insertExtraBinding(
      fixture.raw,
      fixture.domainId,
      "fireflies",
    );

    // Page has 3 citations: one from the forgotten binding (fixture's
    // default `drive` binding) + two from other bindings.
    const PAGE = "strategy/onboarding.md";
    await insertCitation(fixture.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: fixture.bindingId,
      sourceRef: "drive:doc-forgotten",
    });
    await insertCitation(fixture.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: otherBindingA,
      sourceRef: "asana:project-1",
    });
    await insertCitation(fixture.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: otherBindingB,
      sourceRef: "fireflies:transcript-1",
    });

    const { hook, calls } = makeSpyHook();
    const deps: ForgetRecompileDeps = {
      db: fixture.db as unknown as ForgetRecompileDeps["db"],
      logger: silentLogger(),
      recompilePage: hook,
    };
    const handler = buildForgetRecompileHandler(deps);

    await handler(
      fakeJob({
        bindingId: fixture.bindingId,
        domainSlug: "test-domain",
        pagePath: PAGE,
        callerUsername: "alice",
      }),
    );

    // Forgotten binding's citation should be GONE; the other two
    // remain (we only delete the row that matches the binding).
    const after = await fixture.raw.query<{
      source_binding_id: string;
      source_ref: string;
    }>(
      `SELECT source_binding_id::text AS source_binding_id, source_ref
       FROM page_citations
       WHERE domain_slug = $1 AND page_path = $2
       ORDER BY source_ref`,
      ["test-domain", PAGE],
    );
    expect(after.rows.map((r) => r.source_ref)).toEqual([
      "asana:project-1",
      "fireflies:transcript-1",
    ]);
    // No row from the forgotten binding survives this page.
    expect(
      after.rows.some((r) => r.source_binding_id === fixture.bindingId),
    ).toBe(false);

    // Hook was invoked exactly once with the remaining 2 citations.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      bindingId: fixture.bindingId,
      domainSlug: "test-domain",
      pagePath: PAGE,
      callerUsername: "alice",
    });
    const remaining = calls[0]!.remainingCitations;
    expect(remaining).toHaveLength(2);
    const remainingRefs = remaining.map((r) => r.sourceRef).sort();
    expect(remainingRefs).toEqual([
      "asana:project-1",
      "fireflies:transcript-1",
    ]);
    // Defensive: NO remaining citation row references the forgotten
    // binding (that would mean the handler queried before the DELETE
    // and forwarded a stale list).
    for (const r of remaining) {
      expect(r.sourceBindingId).not.toBe(fixture.bindingId);
    }
  });

  it("does NOT recompile when every citation is from the forgotten binding", async () => {
    // Race-resilience: the route's planner should classify this page
    // as `pagesDeleted` (not `pagesRecompiled`) so the worker really
    // shouldn't see it. But a concurrent edit between plan + consume
    // could land the wrong job here. Defensive: log + no-op rather
    // than recompile-with-no-input.
    const fixture = await freshPipelineDb();
    const PAGE = "strategy/orphan.md";
    await insertCitation(fixture.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: fixture.bindingId,
      sourceRef: "drive:doc-only",
    });
    await insertCitation(fixture.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: fixture.bindingId,
      sourceRef: "drive:doc-also-only",
    });

    const { hook, calls } = makeSpyHook();
    const handler = buildForgetRecompileHandler({
      db: fixture.db as unknown as ForgetRecompileDeps["db"],
      logger: silentLogger(),
      recompilePage: hook,
    });

    await handler(
      fakeJob({
        bindingId: fixture.bindingId,
        domainSlug: "test-domain",
        pagePath: PAGE,
        callerUsername: "alice",
      }),
    );

    // Hook NOT called.
    expect(calls).toHaveLength(0);
    // Citation rows still in place — the delete worker (separate job)
    // owns the cascade prune for this page.
    const after = await fixture.raw.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM page_citations
       WHERE domain_slug = $1 AND page_path = $2`,
      ["test-domain", PAGE],
    );
    expect(Number.parseInt(after.rows[0]!.count, 10)).toBe(2);
  });

  it("no-ops with a warn log when the page has no recorded citations", async () => {
    // Race between forget-plan and consume — the route saw citations
    // but they're gone now (e.g. another forget already drained
    // them). Defensive: warn + no-op (no point retrying).
    const fixture = await freshPipelineDb();
    const logs: string[] = [];
    const captureLogger = new ConsoleLogger({
      stream: {
        write: (chunk: string): boolean => {
          logs.push(chunk);
          return true;
        },
      },
    });
    const { hook, calls } = makeSpyHook();
    const handler = buildForgetRecompileHandler({
      db: fixture.db as unknown as ForgetRecompileDeps["db"],
      logger: captureLogger,
      recompilePage: hook,
    });

    await handler(
      fakeJob({
        bindingId: fixture.bindingId,
        domainSlug: "test-domain",
        pagePath: "strategy/missing.md",
        callerUsername: "alice",
      }),
    );

    expect(calls).toHaveLength(0);
    const joined = logs.join("");
    expect(joined).toContain("forget_consumer.recompile.page_missing");
    expect(joined).toContain("strategy/missing.md");
  });

  it("re-throws when the recompile hook fails (so BullMQ retries)", async () => {
    const fixture = await freshPipelineDb();
    const otherBinding = await insertExtraBinding(
      fixture.raw,
      fixture.domainId,
      "asana",
    );
    const PAGE = "strategy/will-fail.md";
    await insertCitation(fixture.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: fixture.bindingId,
      sourceRef: "drive:doc",
    });
    await insertCitation(fixture.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: otherBinding,
      sourceRef: "asana:project",
    });

    const failingHook: RecompilePageHook = vi.fn(async () => {
      throw new Error("upstream LLM 503");
    });
    const handler = buildForgetRecompileHandler({
      db: fixture.db as unknown as ForgetRecompileDeps["db"],
      logger: silentLogger(),
      recompilePage: failingHook,
    });

    await expect(
      handler(
        fakeJob({
          bindingId: fixture.bindingId,
          domainSlug: "test-domain",
          pagePath: PAGE,
          callerUsername: "alice",
        }),
      ),
    ).rejects.toThrow(/upstream LLM 503/);
  });

  it("does NOT touch citations for OTHER pages on the same domain", async () => {
    // Cross-page isolation: a forget targeting page A must not prune
    // citations for page B even if both pages cite the forgotten
    // binding.
    const fixture = await freshPipelineDb();
    const otherBinding = await insertExtraBinding(
      fixture.raw,
      fixture.domainId,
      "asana",
    );
    const PAGE_A = "strategy/a.md";
    const PAGE_B = "strategy/b.md";
    await insertCitation(fixture.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE_A,
      sourceBindingId: fixture.bindingId,
      sourceRef: "drive:a",
    });
    await insertCitation(fixture.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE_A,
      sourceBindingId: otherBinding,
      sourceRef: "asana:a",
    });
    // Page B also cites the forgotten binding.
    await insertCitation(fixture.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE_B,
      sourceBindingId: fixture.bindingId,
      sourceRef: "drive:b",
    });

    const { hook } = makeSpyHook();
    const handler = buildForgetRecompileHandler({
      db: fixture.db as unknown as ForgetRecompileDeps["db"],
      logger: silentLogger(),
      recompilePage: hook,
    });

    // Process job for page A only.
    await handler(
      fakeJob({
        bindingId: fixture.bindingId,
        domainSlug: "test-domain",
        pagePath: PAGE_A,
        callerUsername: "alice",
      }),
    );

    // Page B's citation from the forgotten binding still present.
    const result = (await fixture.db.execute(sql`
      SELECT page_path FROM page_citations
      WHERE domain_slug = 'test-domain'
        AND source_binding_id = ${fixture.bindingId}::uuid
      ORDER BY page_path
    `)) as unknown as { rows: Array<{ page_path: string }> };
    expect(result.rows.map((r) => r.page_path)).toEqual([PAGE_B]);
  });
});
