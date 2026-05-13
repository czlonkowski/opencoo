/**
 * Worldview composition bundle tests — PR-W1 (phase-a appendix #13).
 *
 *   - safety-net cron registration: default pattern, operator override,
 *     test-seam recorder, best-effort failure (degrades cleanly).
 *   - worker construction: production path uses
 *     `startWorldviewCompileWorker`; test-seam `null` skips it
 *     (queue + cron still register).
 */
import IORedisMock from "ioredis-mock";
import { describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";

import {
  WORLDVIEW_SAFETY_NET_CRON_DEFAULT,
  WORLDVIEW_SAFETY_NET_REPEAT_KEY,
  composeWorldviewBundle,
  type ComposeWorldviewBundleArgs,
} from "../../src/composition/worldview-bundle.js";

import { freshAgentDb } from "../agent-harness/_pglite-fixture.js";

void IORedisMock;

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

interface StubQueue {
  readonly addCalls: Array<{
    name: string;
    data: unknown;
    opts: unknown;
  }>;
  add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

function makeStubQueue(): StubQueue {
  const calls: StubQueue["addCalls"] = [];
  return {
    addCalls: calls,
    async add(name, data, opts) {
      calls.push({ name, data, opts });
      return { id: `job-${calls.length}` };
    },
    async close() {
      // no-op
    },
  };
}

async function buildArgs(
  overrides: Partial<ComposeWorldviewBundleArgs> = {},
): Promise<{
  readonly args: ComposeWorldviewBundleArgs;
  readonly stubQueue: StubQueue;
}> {
  const fixture = await freshAgentDb();
  const wiki = new InMemoryWikiAdapter();
  const logger = silentLogger();
  const stubQueue = makeStubQueue();
  return {
    stubQueue,
    args: {
      db: fixture.db as unknown as ComposeWorldviewBundleArgs["db"],
      logger,
      redisConnection: { host: "stub", port: 0 },
      router: {} as unknown as ComposeWorldviewBundleArgs["router"],
      wikiAdapter: wiki,
      wikiDeps: {
        adapter: wiki,
        queue: new InMemoryWikiWriteQueue(),
        deleteCap: new InMemoryDeleteCap(),
        logger,
        clock: () => new Date("2026-05-11T12:00:00Z"),
        instanceId: "test-instance",
      },
      author: { name: "opencoo-test", email: "test@opencoo.local" },
      // Default test seam — bypass real BullMQ.
      queueFactory: () => stubQueue,
      // Default test seam — never construct a real Worker.
      startWorkerFn: null,
      ...overrides,
    },
  };
}

describe("composeWorldviewBundle — safety-net cron registration", () => {
  it("registers the safety-net cron at default cadence (0 3 * * * UTC)", async () => {
    const { args, stubQueue } = await buildArgs();
    const bundle = await composeWorldviewBundle(args);
    expect(stubQueue.addCalls).toHaveLength(1);
    const call = stubQueue.addCalls[0]!;
    expect((call.opts as { jobId: string }).jobId).toBe(
      WORLDVIEW_SAFETY_NET_REPEAT_KEY,
    );
    const repeat = (call.opts as { repeat: { pattern: string; tz: string } })
      .repeat;
    expect(repeat.pattern).toBe(WORLDVIEW_SAFETY_NET_CRON_DEFAULT);
    expect(repeat.tz).toBe("UTC");
    await bundle.close();
  });

  it("honours an operator-supplied safetyNetCronPattern override", async () => {
    const { args, stubQueue } = await buildArgs({
      safetyNetCronPattern: "*/30 * * * *",
    });
    const bundle = await composeWorldviewBundle(args);
    const repeat = (stubQueue.addCalls[0]?.opts as {
      repeat: { pattern: string };
    }).repeat;
    expect(repeat.pattern).toBe("*/30 * * * *");
    await bundle.close();
  });

  it("uses the test-seam registerWorldviewSafetyNetCronFn when supplied", async () => {
    const registerCalls: Array<{ repeatKey: string; pattern: string }> = [];
    const { args, stubQueue } = await buildArgs({
      registerWorldviewSafetyNetCronFn: async ({ repeatKey, pattern }) => {
        registerCalls.push({ repeatKey, pattern });
      },
    });
    const bundle = await composeWorldviewBundle(args);
    expect(registerCalls).toEqual([
      {
        repeatKey: WORLDVIEW_SAFETY_NET_REPEAT_KEY,
        pattern: WORLDVIEW_SAFETY_NET_CRON_DEFAULT,
      },
    ]);
    // The test seam bypasses the queue.add path — no add call.
    expect(stubQueue.addCalls).toHaveLength(0);
    await bundle.close();
  });

  it("degrades cleanly when cron registration throws (best-effort)", async () => {
    const { args } = await buildArgs({
      registerWorldviewSafetyNetCronFn: async () => {
        throw new Error("simulated redis outage");
      },
    });
    // Bundle should still construct + close cleanly.
    const bundle = await composeWorldviewBundle(args);
    expect(bundle.queue).toBeDefined();
    expect(bundle.worker).toBe(null); // test seam skipped Worker.
    await bundle.close();
  });
});

describe("composeWorldviewBundle — worker lifecycle", () => {
  it("constructs the worker when startWorkerFn is not overridden", async () => {
    // Build args with a real-shape startWorkerFn substitute (returns
    // a stub Worker-like) so we can assert it's invoked + closed.
    const closeWorker = vi.fn(async () => undefined);
    const startCalls: Array<unknown> = [];
    const stubWorker = {
      on: () => undefined,
      close: closeWorker,
    } as unknown as ReturnType<
      Exclude<ComposeWorldviewBundleArgs["startWorkerFn"], null | undefined>
    >;
    const { args } = await buildArgs({
      startWorkerFn: ((opts) => {
        startCalls.push(opts);
        return stubWorker;
      }) as ComposeWorldviewBundleArgs["startWorkerFn"],
    });
    const bundle = await composeWorldviewBundle(args);
    expect(startCalls).toHaveLength(1);
    expect(bundle.worker).toBe(stubWorker);
    await bundle.close();
    expect(closeWorker).toHaveBeenCalled();
  });

  it("close() is idempotent — second call is a no-op", async () => {
    const closeWorker = vi.fn(async () => undefined);
    const stubWorker = {
      on: () => undefined,
      close: closeWorker,
    } as unknown as Exclude<
      Awaited<ReturnType<typeof composeWorldviewBundle>>["worker"],
      null
    >;
    const { args } = await buildArgs({
      startWorkerFn: (() => stubWorker) as ComposeWorldviewBundleArgs["startWorkerFn"],
    });
    const bundle = await composeWorldviewBundle(args);
    await bundle.close();
    await bundle.close();
    // Worker.close runs at most once — idempotent close cache.
    expect(closeWorker).toHaveBeenCalledTimes(1);
  });
});
