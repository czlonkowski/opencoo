/**
 * Worldview compiler worker tests — PR-W1 (phase-a appendix #13).
 *
 * Drives `runWorldviewCompile` (the pure handler extracted from
 * `buildWorldviewCompileHandler`) against:
 *
 *   - happy path: lists pages, drops `worldview.md`, calls the
 *     real `compileDomainWorldview`, writes via `wikiWrite()`
 *     with the `[worldview]` tag + `Worldview-Recompile:` trailer.
 *   - WorldviewOverflowError → DLQ (status: 'overflow'), wikiWrite
 *     NOT called.
 *   - transient errors → re-throw.
 *   - safety-net fanout: sentinel ids cause per-domain re-enqueue.
 *   - safety-net fanout without composition hooks → degrades
 *     cleanly without crashing.
 */
import { describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import type { DomainSlug } from "@opencoo/shared/db";
import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiAuthor,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";

import {
  SAFETY_NET_FANOUT_SENTINEL,
  buildWorldviewCompileHandler,
  runWorldviewCompile,
  type WorldviewCompileJob,
  type WorldviewCompileResult,
} from "../../src/workers/worldview-compiler-worker.js";
import {
  WORLDVIEW_BODY_MAX_BYTES,
} from "../../src/pipelines/worldview/types.js";

import { freshAgentDb } from "../agent-harness/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function fakeProvider(responses: ReadonlyArray<unknown>): LlmProvider {
  let i = 0;
  return {
    generate: async () => {
      const r = responses[i] ?? responses[responses.length - 1];
      i++;
      return {
        text: typeof r === "string" ? r : JSON.stringify(r),
        tokensIn: 5,
        tokensOut: 5,
      };
    },
  };
}

function makeRouter(provider: LlmProvider, db: unknown): LlmRouter {
  return new LlmRouter({
    db: db as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: {
      paused: () => false,
      pause: () => undefined,
      resume: () => undefined,
    },
    provider,
  });
}

interface Harness {
  readonly wiki: InMemoryWikiAdapter;
  readonly wikiDeps: WikiWriteDeps;
  readonly author: WikiAuthor;
  readonly logger: ReturnType<typeof silentLogger>;
}

function buildHarness(): Harness {
  const wiki = new InMemoryWikiAdapter();
  const logger = silentLogger();
  const wikiDeps: WikiWriteDeps = {
    adapter: wiki,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: new InMemoryDeleteCap(),
    logger,
    clock: () => new Date("2026-05-11T12:00:00Z"),
    instanceId: "test-instance",
  };
  return {
    wiki,
    wikiDeps,
    author: { name: "opencoo-test", email: "test@opencoo.local" },
    logger,
  };
}

const SLUG = "test-domain" as DomainSlug;

describe("runWorldviewCompile — happy path", () => {
  it("lists pages, drops worldview.md, calls compileDomainWorldview, writes via wikiWrite", async () => {
    const fixture = await freshAgentDb();
    const h = buildHarness();
    h.wiki.inject(SLUG, "team/eng.md", "# eng team");
    h.wiki.inject(SLUG, "projects/q3.md", "# q3");
    // Inject a prior worldview.md — the worker MUST NOT pass it
    // back into the compiler (it's the output target).
    h.wiki.inject(SLUG, "worldview.md", "# old worldview");

    const router = makeRouter(
      fakeProvider([{ version: "v1", body: "# compiled worldview" }]),
      fixture.db,
    );

    const job: WorldviewCompileJob = {
      domainId: fixture.domainId,
      domainSlug: SLUG,
      triggerType: "trailer-high",
    };
    const result = await runWorldviewCompile({
      router,
      wikiAdapter: h.wiki,
      wikiDeps: h.wikiDeps,
      author: h.author,
      logger: h.logger,
      resolveLocale: async () => "en",
      job,
    });
    expect(result.status).toBe("ok");
    expect(result.bodyBytes).toBeGreaterThan(0);
    expect(result.sha).toBeTruthy();
    expect(result.retried).toBe(false);

    // Worldview.md was rewritten with the compiled body.
    const updated = await h.wiki.readPage(SLUG, "worldview.md");
    expect(updated?.content).toContain("compiled worldview");
  });

  it("emits commit with [worldview] tag + Worldview-Recompile trailer carrying triggerType", async () => {
    const fixture = await freshAgentDb();
    const h = buildHarness();
    h.wiki.inject(SLUG, "p.md", "# page");

    // Spy on wikiWrite by intercepting writeAtomic — the resulting
    // commit message contains the tag + trailer.
    const captured: string[] = [];
    const origWriteAtomic = h.wiki.writeAtomic.bind(h.wiki);
    h.wiki.writeAtomic = async (args) => {
      captured.push(args.commitMessage);
      return origWriteAtomic(args);
    };

    const router = makeRouter(
      fakeProvider([{ version: "v1", body: "# wv" }]),
      fixture.db,
    );

    await runWorldviewCompile({
      router,
      wikiAdapter: h.wiki,
      wikiDeps: h.wikiDeps,
      author: h.author,
      logger: h.logger,
      resolveLocale: async () => "en",
      job: {
        domainId: fixture.domainId,
        domainSlug: SLUG,
        triggerType: "trailer-medium",
      },
    });
    expect(captured.length).toBe(1);
    const msg = captured[0]!;
    expect(msg.startsWith("[worldview] worldview-compile: trailer-medium")).toBe(true);
    expect(msg).toContain("Worldview-Recompile: trailer-medium");
    expect(msg).toContain("Opencoo-Instance: test-instance");
  });
});

describe("runWorldviewCompile — WorldviewOverflowError DLQ path", () => {
  it("returns status='overflow' + does NOT write worldview.md when both compile attempts overflow", async () => {
    const fixture = await freshAgentDb();
    const h = buildHarness();
    h.wiki.inject(SLUG, "p.md", "# page");

    // Track whether wikiWrite touched the adapter.
    let writeCalls = 0;
    const origWriteAtomic = h.wiki.writeAtomic.bind(h.wiki);
    h.wiki.writeAtomic = async (args) => {
      writeCalls += 1;
      return origWriteAtomic(args);
    };

    // Oversized body twice → WorldviewOverflowError.
    const oversized = "x".repeat(WORLDVIEW_BODY_MAX_BYTES + 50);
    const router = makeRouter(
      fakeProvider([
        { version: "v1", body: oversized },
        { version: "v1", body: oversized },
      ]),
      fixture.db,
    );

    const result = await runWorldviewCompile({
      router,
      wikiAdapter: h.wiki,
      wikiDeps: h.wikiDeps,
      author: h.author,
      logger: h.logger,
      resolveLocale: async () => "en",
      job: {
        domainId: fixture.domainId,
        domainSlug: SLUG,
        triggerType: "manual",
      },
    });
    expect(result.status).toBe("overflow");
    expect(writeCalls).toBe(0);
  });
});

describe("runWorldviewCompile — transient error", () => {
  it("re-throws non-overflow errors so BullMQ retries", async () => {
    const fixture = await freshAgentDb();
    const h = buildHarness();
    h.wiki.inject(SLUG, "p.md", "# page");

    // Provider that throws a generic Error — emulates a transient
    // provider outage. The handler MUST re-throw so BullMQ's
    // attempts policy kicks in.
    const router = makeRouter(
      {
        generate: async () => {
          throw new Error("provider-down");
        },
      },
      fixture.db,
    );

    await expect(
      runWorldviewCompile({
        router,
        wikiAdapter: h.wiki,
        wikiDeps: h.wikiDeps,
        author: h.author,
        logger: h.logger,
        resolveLocale: async () => "en",
        job: {
          domainId: fixture.domainId,
          domainSlug: SLUG,
          triggerType: "trailer-high",
        },
      }),
    ).rejects.toThrow(); // any non-overflow throw → re-thrown for BullMQ retry
  });
});

describe("runWorldviewCompile — safety-net fanout", () => {
  it("fans out to per-domain jobs when the cron sentinel arrives", async () => {
    const fixture = await freshAgentDb();
    const h = buildHarness();

    // Mock fanout hooks.
    const listed: Array<{ domainId: string; domainSlug: string }> = [
      { domainId: "domain-a-id", domainSlug: "domain-a" },
      { domainId: "domain-b-id", domainSlug: "domain-b" },
    ];
    const enqueueCalls: WorldviewCompileJob[] = [];

    const router = makeRouter(fakeProvider([{}]), fixture.db);
    const result = await runWorldviewCompile({
      router,
      wikiAdapter: h.wiki,
      wikiDeps: h.wikiDeps,
      author: h.author,
      logger: h.logger,
      resolveLocale: async () => "en",
      listSafetyNetDomains: async () => listed,
      enqueueSafetyNetFanout: async (job) => {
        enqueueCalls.push(job);
      },
      job: {
        domainId: SAFETY_NET_FANOUT_SENTINEL,
        domainSlug: SAFETY_NET_FANOUT_SENTINEL,
        triggerType: "safety-net",
      },
    });
    expect(result.status).toBe("ok");
    expect(enqueueCalls).toHaveLength(2);
    expect(enqueueCalls.map((j) => j.domainSlug)).toEqual([
      "domain-a",
      "domain-b",
    ]);
    expect(enqueueCalls.every((j) => j.triggerType === "safety-net")).toBe(
      true,
    );
  });

  it("degrades cleanly when fanout hooks are missing (composition incomplete)", async () => {
    const fixture = await freshAgentDb();
    const h = buildHarness();
    const router = makeRouter(fakeProvider([{}]), fixture.db);
    const result = await runWorldviewCompile({
      router,
      wikiAdapter: h.wiki,
      wikiDeps: h.wikiDeps,
      author: h.author,
      logger: h.logger,
      resolveLocale: async () => "en",
      // listSafetyNetDomains + enqueueSafetyNetFanout deliberately
      // omitted — the worker logs a warning and returns ok.
      job: {
        domainId: SAFETY_NET_FANOUT_SENTINEL,
        domainSlug: SAFETY_NET_FANOUT_SENTINEL,
        triggerType: "safety-net",
      },
    });
    expect(result.status).toBe("ok");
  });
});

describe("buildWorldviewCompileHandler — Job wrapper", () => {
  it("unpacks job.data and forwards it to runWorldviewCompile", async () => {
    const fixture = await freshAgentDb();
    const h = buildHarness();
    h.wiki.inject(SLUG, "p.md", "# page");
    const router = makeRouter(
      fakeProvider([{ version: "v1", body: "# wv" }]),
      fixture.db,
    );

    const handler = buildWorldviewCompileHandler({
      router,
      wikiAdapter: h.wiki,
      wikiDeps: h.wikiDeps,
      author: h.author,
      logger: h.logger,
      resolveLocale: async () => "en",
    });

    // BullMQ Job mock — only the `data` field is read by the handler.
    const job = {
      data: {
        domainId: fixture.domainId,
        domainSlug: SLUG,
        triggerType: "manual" as const,
      },
    } as Parameters<typeof handler>[0];

    const result = (await handler(job)) as WorldviewCompileResult;
    expect(result.status).toBe("ok");
  });
});

// Silence unused-import lint.
void vi;
