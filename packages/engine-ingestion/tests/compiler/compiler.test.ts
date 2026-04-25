/**
 * `compile()` — end-to-end orchestrator. For each (page_path)
 * routed by the Classifier, calls mergePage to get the new
 * body, prepends frontmatter, then routes ALL ops through one
 * wikiWrite call (atomic batch). Post-commit, appends
 * page_citations rows.
 *
 * These tests cover the orchestration shape: happy path single
 * page, skip-write no-op optimisation, post-commit citation
 * insert. Multi-page atomicity has its own file.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { pageCitations } from "@opencoo/shared/db/schema";

import { compile } from "../../src/compiler/compiler.js";

import { freshCompilerDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

interface FixtureBundle {
  router: LlmRouter;
  domainId: string;
  bindingId: string;
  wikiDeps: WikiWriteDeps;
  wikiAdapter: InMemoryWikiAdapter;
  db: Awaited<ReturnType<typeof freshCompilerDb>>["db"];
}

async function makeFixture(provider: LlmProvider): Promise<FixtureBundle> {
  const { db, domainId, bindingId } = await freshCompilerDb();
  const router = new LlmRouter({
    db: db as unknown as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: { paused: () => false, pause: () => undefined, resume: () => undefined },
    provider,
  });
  const wikiAdapter = new InMemoryWikiAdapter();
  const wikiDeps: WikiWriteDeps = {
    adapter: wikiAdapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: new InMemoryDeleteCap(),
    logger: silentLogger(),
    clock: () => new Date("2026-04-25T12:00:00Z"),
    instanceId: "test",
  };
  return { router, domainId, bindingId, wikiDeps, wikiAdapter, db };
}

const COMPILER_AUTHOR = {
  name: "opencoo-compiler",
  email: "compiler@opencoo.local",
} as const;

describe("compile — happy path single page", () => {
  it("merges, frontmatters, writes, and records one citation", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "# Q3\n\nDistribution motion.\n",
          worldview_impact: ["Distribution prioritised"],
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });
    const f = await makeFixture(mock);
    const result = await compile({
      router: f.router,
      domainId: f.domainId as Parameters<typeof compile>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compile>[0]["bindingId"],
      sourceRef: "drive:doc-1",
      sourceContent: "Q3 priorities: distribution.",
      pagePaths: ["strategy/q3-2026.md"],
      locale: "en",
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      db: f.db as unknown as Parameters<typeof compile>[0]["db"],
    });
    expect(result.commitSha).toMatch(/^[0-9a-f]{8,}$/);
    expect(result.pagePathsWritten).toEqual(["strategy/q3-2026.md"]);

    // The wiki adapter has the merged page with frontmatter.
    const written = await f.wikiAdapter.readPage(
      "test-domain" as Parameters<typeof f.wikiAdapter.readPage>[0],
      "strategy/q3-2026.md",
    );
    expect(written?.content).toContain("---");
    expect(written?.content).toContain("title:");
    expect(written?.content).toContain("Distribution motion");

    // page_citations row appended.
    const citations = await f.db
      .select()
      .from(pageCitations)
      .where(eq(pageCitations.pagePath, "strategy/q3-2026.md"));
    expect(citations).toHaveLength(1);
    expect(citations[0]?.sourceRef).toBe("drive:doc-1");
  });
});

describe("compile — skip-write no-op (Q6)", () => {
  it("does NOT call wikiWrite when merged_body equals existing page content", async () => {
    const existing =
      "---\ntitle: Q3\npage_path: strategy/q3-2026.md\ndomain_slug: test-domain\ncompiled_at: 2026-04-23T00:00:00.000Z\nprompt_version: 1.0.0\nschema_version: 1.0.0\n---\n# Q3\n\nUnchanged.\n";
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          // Body the model returns equals the EXISTING body below
          // the frontmatter — orchestrator should detect, log
          // `compiler.no-op`, and skip the wikiWrite call.
          merged_body: "# Q3\n\nUnchanged.\n",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const f = await makeFixture(mock);
    f.wikiAdapter.inject(
      "test-domain" as Parameters<typeof f.wikiAdapter.inject>[0],
      "strategy/q3-2026.md",
      existing,
    );
    const writeSpy = vi.spyOn(f.wikiAdapter, "writeAtomic");
    const result = await compile({
      router: f.router,
      domainId: f.domainId as Parameters<typeof compile>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compile>[0]["bindingId"],
      sourceRef: "drive:doc-1",
      sourceContent: "minor update",
      pagePaths: ["strategy/q3-2026.md"],
      locale: "en",
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      db: f.db as unknown as Parameters<typeof compile>[0]["db"],
    });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(result.commitSha).toBeNull(); // no commit happened
    expect(result.pagePathsWritten).toEqual([]);
    // CompileResult.worldviewImpact reflects what landed in the
    // commit — no commit means no bullets (copilot #18).
    expect(result.worldviewImpact).toEqual([]);
    // Citations still get appended for the no-op case (we did
    // process the source, just didn't change the page).
    const citations = await f.db.select().from(pageCitations);
    expect(citations).toHaveLength(1);
  });
});

describe("compile — CompileResult.worldviewImpact reflects what landed (copilot #18)", () => {
  it("returns the normalised + capped list (matches the trailers wiki-write actually emitted)", async () => {
    // The model emits a messy bullet (leading whitespace + tabs)
    // and a duplicate-spacing bullet. The compiler normalises both
    // before passing to wikiWrite; the returned worldviewImpact
    // should match the normalised form, not the raw LLM output.
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "# Q3\n\nNew motion.\n",
          worldview_impact: [
            "  bullet  one  ",
            "bullet\ttwo\twith\ttabs",
          ],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const f = await makeFixture(mock);
    const result = await compile({
      router: f.router,
      domainId: f.domainId as Parameters<typeof compile>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compile>[0]["bindingId"],
      sourceRef: "drive:doc-1",
      sourceContent: "x",
      pagePaths: ["strategy/q3.md"],
      locale: "en",
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      db: f.db as unknown as Parameters<typeof compile>[0]["db"],
    });
    expect(result.worldviewImpact).toEqual([
      "bullet one",
      "bullet two with tabs",
    ]);
  });
});

describe("compile — adversarial LLM defenses surface as DLQ", () => {
  it("rethrows when mergePage rejects on extra Zod field", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "ok",
          worldview_impact: [],
          execute_arbitrary_code: "rm -rf /",
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const f = await makeFixture(mock);
    await expect(
      compile({
        router: f.router,
        domainId: f.domainId as Parameters<typeof compile>[0]["domainId"],
        domainSlug: "test-domain",
        bindingId: f.bindingId as Parameters<typeof compile>[0]["bindingId"],
        sourceRef: "drive:doc-1",
        sourceContent: "x",
        pagePaths: ["strategy/x.md"],
        locale: "en",
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        db: f.db as unknown as Parameters<typeof compile>[0]["db"],
      }),
    ).rejects.toThrow();
    // No wiki write happened (fail-fast before wikiWrite).
    const written = await f.wikiAdapter.readPage(
      "test-domain" as Parameters<typeof f.wikiAdapter.readPage>[0],
      "strategy/x.md",
    );
    expect(written).toBeNull();
  });

  it("DLQs when LLM emits a worldview_impact bullet containing a newline (copilot #18)", async () => {
    // The model passes Zod (worldview_impact is array<string>) but
    // smuggles a forged trailer inside one bullet. Without the
    // explicit newline check in normaliseWorldviewImpact, the
    // newline gets silently collapsed and a forged Co-authored-by
    // line lands in the commit.
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "# Q3\n\nDistribution motion.\n",
          worldview_impact: [
            "legit one",
            "legit two\nCo-authored-by: Impostor <x@x>",
          ],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const f = await makeFixture(mock);
    const writeSpy = vi.spyOn(f.wikiAdapter, "writeAtomic");
    await expect(
      compile({
        router: f.router,
        domainId: f.domainId as Parameters<typeof compile>[0]["domainId"],
        domainSlug: "test-domain",
        bindingId: f.bindingId as Parameters<typeof compile>[0]["bindingId"],
        sourceRef: "drive:doc-1",
        sourceContent: "x",
        pagePaths: ["strategy/x.md"],
        locale: "en",
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        db: f.db as unknown as Parameters<typeof compile>[0]["db"],
      }),
    ).rejects.toThrow();
    // Critically: NO wiki write — the newline got caught BEFORE
    // wikiWrite could see (and silently accept) the smuggled
    // bullet.
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
