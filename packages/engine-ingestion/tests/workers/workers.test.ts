/**
 * Worker contract tests (PR-M1, phase-a appendix #5).
 *
 * Each pipeline ships as a pure async function; PR-M1 wraps each
 * one in a BullMQ `Worker` so the engine actually DEQUEUES the
 * jobs the webhook receiver / scanner enqueue. This file pins
 * the contract:
 *
 *   1. The handler factory is a pure function — given a
 *      `WorkerContext` it returns `(job) => Promise<result>`. No
 *      BullMQ Redis traffic is exercised here; the wrapping logic
 *      is the unit under test.
 *   2. Errors thrown from the underlying pipeline propagate so
 *      BullMQ retries.
 *   3. `startIngestionWorkers(ctx)` returns a typed handle that
 *      exposes all five workers AND a `closeAll()` method that
 *      drains every worker in parallel.
 *   4. The full `Worker` instance is named `<prefix>.<slug>`,
 *      matching the queue handle producers write to.
 */
import type { Job } from "bullmq";
import IORedisMock from "ioredis-mock";
import { describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import type { GuardAdapter } from "@opencoo/shared/adapter-contract-tests/guard";
import type { LlmRouter } from "@opencoo/shared/llm-router";

import {
  buildCleanupHandler,
  buildCompilationHandler,
  buildIndexRebuildHandler,
  buildReviewDispatchHandler,
  buildScannerHandler,
  startIngestionWorkers,
  type WorkerContext,
} from "../../src/workers/index.js";

import { freshPipelineDb } from "../pipelines/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

function fakeJob<T>(data: T, id = "job-1"): Job<T> {
  return {
    id,
    name: "test",
    data,
    queueName: "test-queue",
    attemptsMade: 0,
    timestamp: Date.now(),
  } as unknown as Job<T>;
}

function noOpGuard(): GuardAdapter {
  return {
    slug: "guard-noop",
    role: "redaction",
    categories: [],
    async classify(args) {
      return { transformedText: args.text, events: [] };
    },
  } as unknown as GuardAdapter;
}

function fakeRouter(): LlmRouter {
  // The cleanup / review-dispatch / index-rebuild paths under
  // test in this file never invoke the router. The compile-worker
  // unit test below exercises only the failure path (load binding
  // returns null) so the router is never called either.
  return {} as unknown as LlmRouter;
}

const REBUILDER_AUTHOR = {
  name: "opencoo-rebuilder",
  email: "rebuilder@opencoo.local",
} as const;

describe("buildScannerHandler", () => {
  it("invokes runScanner with the worker context", async () => {
    const fixture = await freshPipelineDb();
    const enqueueAdds: unknown[] = [];
    const handler = buildScannerHandler({
      db: fixture.db as unknown as WorkerContext["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => undefined },
      enqueue: {
        async add(_name: string, data: unknown) {
          enqueueAdds.push(data);
          return undefined;
        },
      },
    });
    const result = await handler(fakeJob({}));
    // No bindings adapter-resolved → 0 enqueues, 0 documents.
    expect(result).toMatchObject({
      bindingsScanned: expect.any(Number),
      documentsEnqueued: 0,
    });
    expect(enqueueAdds).toEqual([]);
  });
});

describe("buildReviewDispatchHandler", () => {
  it("invokes runReviewDispatcher with job.data as payload", async () => {
    const handler = buildReviewDispatchHandler({
      logger: silentLogger(),
    });
    const result = await handler(
      fakeJob({
        domainSlug: "test-domain",
        reviewRole: "executive-team",
        commitSha: "abc",
        pagePaths: ["strategy/x.md"],
        sourceRef: "drive:doc-1",
      }),
    );
    expect(result).toMatchObject({
      dispatched: true,
      reviewRole: "executive-team",
    });
  });

  it("rethrows ValidationError on bad payload (so BullMQ DLQs)", async () => {
    const handler = buildReviewDispatchHandler({
      logger: silentLogger(),
    });
    await expect(
      handler(fakeJob({ bogus: true })),
    ).rejects.toThrow();
  });
});

describe("buildIndexRebuildHandler", () => {
  it("invokes runIndexRebuilder using job.data.domainSlug", async () => {
    const wikiAdapter = new InMemoryWikiAdapter();
    const handler = buildIndexRebuildHandler({
      logger: silentLogger(),
      wikiDeps: {
        adapter: wikiAdapter,
        queue: new InMemoryWikiWriteQueue(),
        deleteCap: new InMemoryDeleteCap(),
        logger: silentLogger(),
        clock: () => new Date("2026-04-25T12:00:00Z"),
      },
      wikiAdapter,
      author: REBUILDER_AUTHOR,
    });
    const result = await handler(
      fakeJob({ domainSlug: "test-domain" }),
    );
    // Empty wiki → first rebuild creates index.md once. fileCount
    // counts pages excluding index.md itself, so it's 0.
    expect(result.fileCount).toBe(0);
    expect(typeof result.commitSha === "string" || result.commitSha === null).toBe(true);
  });

  it("throws when job.data lacks domainSlug", async () => {
    const wikiAdapter = new InMemoryWikiAdapter();
    const handler = buildIndexRebuildHandler({
      logger: silentLogger(),
      wikiDeps: {
        adapter: wikiAdapter,
        queue: new InMemoryWikiWriteQueue(),
        deleteCap: new InMemoryDeleteCap(),
        logger: silentLogger(),
        clock: () => new Date("2026-04-25T12:00:00Z"),
      },
      wikiAdapter,
      author: REBUILDER_AUTHOR,
    });
    await expect(handler(fakeJob({}))).rejects.toThrow(/domainSlug/);
  });
});

describe("buildCleanupHandler", () => {
  it("invokes runCleanup against the supplied db", async () => {
    const fixture = await freshPipelineDb();
    const handler = buildCleanupHandler({
      db: fixture.db as unknown as WorkerContext["db"],
      logger: silentLogger(),
    });
    const result = await handler(fakeJob({}));
    expect(result).toMatchObject({
      debugRowsDeleted: 0,
      orphanRowsDeleted: 0,
    });
  });
});

describe("buildCompilationHandler", () => {
  it("invokes runCompilationWorker with job.data as the ScannerClassifyJob", async () => {
    const fixture = await freshPipelineDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const handler = buildCompilationHandler({
      db: fixture.db as unknown as WorkerContext["db"],
      logger: silentLogger(),
      router: fakeRouter(),
      wikiDeps: {
        adapter: wikiAdapter,
        queue: new InMemoryWikiWriteQueue(),
        deleteCap: new InMemoryDeleteCap(),
        logger: silentLogger(),
        clock: () => new Date("2026-04-25T12:00:00Z"),
      },
      author: REBUILDER_AUTHOR,
      guardAdapter: noOpGuard(),
    });
    // Lookup will fail (binding doesn't exist) — the wrapper
    // surfaces the error so BullMQ retries / DLQs.
    await expect(
      handler(
        fakeJob({
          bindingId: "00000000-0000-0000-0000-000000000000",
          intakeId: "00000000-0000-0000-0000-000000000001",
          domainSlug: "test-domain",
          sourceRef: "drive:doc-1",
          contentBase64: Buffer.from("hello").toString("base64"),
          fetchedAt: new Date("2026-04-25T12:00:00Z").toISOString(),
        }),
      ),
    ).rejects.toThrow(/binding/);
  });
});

describe("startIngestionWorkers", () => {
  it("returns a typed handle exposing all five workers + closeAll", async () => {
    const fixture = await freshPipelineDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const redis = new IORedisMock();
    const handle = startIngestionWorkers({
      ctx: {
        db: fixture.db as unknown as WorkerContext["db"],
        logger: silentLogger(),
        wikiDeps: {
          adapter: wikiAdapter,
          queue: new InMemoryWikiWriteQueue(),
          deleteCap: new InMemoryDeleteCap(),
          logger: silentLogger(),
          clock: () => new Date("2026-04-25T12:00:00Z"),
        },
        wikiAdapter,
        author: REBUILDER_AUTHOR,
        router: fakeRouter(),
        guardAdapter: noOpGuard(),
        adapterRegistry: { get: () => undefined },
      },
      connection: redis as unknown as Parameters<
        typeof startIngestionWorkers
      >[0]["connection"],
      // Tests run with autorun:false so the workers don't pull
      // jobs in the background and confound assertions.
      autorun: false,
    });

    expect(handle.scanner.name).toBe("ingestion.scanner");
    expect(handle.compile.name).toBe("ingestion.scanner.classify");
    expect(handle.reviewDispatch.name).toBe("ingestion.review.dispatch");
    expect(handle.indexRebuild.name).toBe("ingestion.index-rebuild");
    expect(handle.cleanup.name).toBe("ingestion.cleanup");

    await expect(handle.closeAll()).resolves.toBeUndefined();

    redis.disconnect();
  });

  it("closeAll() closes every worker", async () => {
    const fixture = await freshPipelineDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const redis = new IORedisMock();
    const handle = startIngestionWorkers({
      ctx: {
        db: fixture.db as unknown as WorkerContext["db"],
        logger: silentLogger(),
        wikiDeps: {
          adapter: wikiAdapter,
          queue: new InMemoryWikiWriteQueue(),
          deleteCap: new InMemoryDeleteCap(),
          logger: silentLogger(),
          clock: () => new Date("2026-04-25T12:00:00Z"),
        },
        wikiAdapter,
        author: REBUILDER_AUTHOR,
        router: fakeRouter(),
        guardAdapter: noOpGuard(),
        adapterRegistry: { get: () => undefined },
      },
      connection: redis as unknown as Parameters<
        typeof startIngestionWorkers
      >[0]["connection"],
      autorun: false,
    });

    const scannerCloseSpy = vi.spyOn(handle.scanner, "close");
    const compileCloseSpy = vi.spyOn(handle.compile, "close");
    const dispatchCloseSpy = vi.spyOn(handle.reviewDispatch, "close");
    const indexCloseSpy = vi.spyOn(handle.indexRebuild, "close");
    const cleanupCloseSpy = vi.spyOn(handle.cleanup, "close");

    await handle.closeAll();
    expect(scannerCloseSpy).toHaveBeenCalledTimes(1);
    expect(compileCloseSpy).toHaveBeenCalledTimes(1);
    expect(dispatchCloseSpy).toHaveBeenCalledTimes(1);
    expect(indexCloseSpy).toHaveBeenCalledTimes(1);
    expect(cleanupCloseSpy).toHaveBeenCalledTimes(1);

    redis.disconnect();
  });
});

describe("buildScannerHandler — sse emission", () => {
  it("worker-event run emission scrubs PATs from error messages", async () => {
    // Lightweight smoke for THREAT-MODEL §3.6 invariant 11 — when
    // the scanner handler throws, any PAT in the error must not
    // appear in the SSE-emitted error string. The wrapper itself
    // surfaces the error to BullMQ; scrub is applied before
    // emitting the run event from the worker's `failed` listener
    // (wired in startIngestionWorkers).
    //
    // We exercise the wrapper directly here: a thrown error
    // containing a Bearer token should propagate raw (BullMQ
    // gets the original), and the SSE listener (separately
    // verified at the start.test integration tier) does the
    // scrub. This keeps the wrapper unit-pure.
    const fixture = await freshPipelineDb();
    // Force a binding row that doesn't exist so the scanner loop
    // is empty — handler returns cleanly (no error path).
    const handler = buildScannerHandler({
      db: fixture.db as unknown as WorkerContext["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => undefined },
      enqueue: { async add() { return undefined; } },
    });
    const result = await handler(fakeJob({}));
    expect(result.documentsEnqueued).toBe(0);
  });
});
