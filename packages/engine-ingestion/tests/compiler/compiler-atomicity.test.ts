/**
 * Multi-page atomicity (Q7): when the Classifier routes a single
 * source to N pages, the compiler MUST gather all merge results
 * BEFORE issuing any wikiWrite call. If ANY mergePage fails
 * (Zod, sentinel scrub, network), no wiki commit happens and
 * the orchestrator throws — no half-written domain.
 */
import { describe, expect, it, vi } from "vitest";

import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { compile } from "../../src/compiler/compiler.js";

import { freshCompilerDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

const COMPILER_AUTHOR = {
  name: "opencoo-compiler",
  email: "compiler@opencoo.local",
} as const;

async function makeFixture(provider: LlmProvider) {
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

describe("compile — multi-page atomicity (Q7)", () => {
  it("batches 3 pages into ONE wikiWrite call", async () => {
    const mock = new MockLlmClient();
    // Register 3 distinct compiler responses keyed on the page-path
    // hint included in each prompt. The orchestrator builds one
    // prompt per page so promptIncludes:'<page>' is a stable match.
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "strategy/q3.md" },
      response: {
        text: JSON.stringify({
          merged_body: "# Q3\n",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "executive/intro.md" },
      response: {
        text: JSON.stringify({
          merged_body: "# Intro\n",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "executive/log.md" },
      response: {
        text: JSON.stringify({
          merged_body: "# Log\n",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const f = await makeFixture(mock);
    const writeSpy = vi.spyOn(f.wikiAdapter, "writeAtomic");
    const result = await compile({
      router: f.router,
      domainId: f.domainId as Parameters<typeof compile>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compile>[0]["bindingId"],
      sourceRef: "drive:doc-1",
      sourceContent: "x",
      pagePaths: ["strategy/q3.md", "executive/intro.md", "executive/log.md"],
      locale: "en",
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      db: f.db as unknown as Parameters<typeof compile>[0]["db"],
    });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0]?.[0].operations).toHaveLength(3);
    expect(result.pagePathsWritten).toHaveLength(3);
  });

  it("fails fast when ONE of N mergePage calls rejects — NO wiki write occurs", async () => {
    const mock = new MockLlmClient();
    // Two valid responses + one adversarial (extra Zod field).
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "strategy/q3.md" },
      response: {
        text: JSON.stringify({
          merged_body: "# Q3\n",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "executive/intro.md" },
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
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "executive/log.md" },
      response: {
        text: JSON.stringify({
          merged_body: "# Log\n",
          worldview_impact: [],
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
        pagePaths: [
          "strategy/q3.md",
          "executive/intro.md",
          "executive/log.md",
        ],
        locale: "en",
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        db: f.db as unknown as Parameters<typeof compile>[0]["db"],
      }),
    ).rejects.toThrow();
    // Crucial: NO wiki write happened. A half-written multi-page
    // commit would leave the domain in a partial state.
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
