/**
 * Compilation Worker — `pipeline.intake_failed` SSE event emission
 * (PR-W4, phase-a appendix #14).
 *
 * W3 made the failure observable in the DB (`status='failed'` plus
 * `error_class`/`error_text`). W4 surfaces that failure as a live
 * event on the SSE bus so the Activity feed shows it without a
 * polling round-trip.
 *
 * Pin matrix:
 *   1. When the worker catches an error (OpencooError OR unknown),
 *      it emits `pipeline.intake_failed` on the supplied event
 *      emitter with the binding/intake ids + classified error.
 *   2. `errorTextSnippet` is truncated to 200 chars and scrubbed
 *      via `safeErrorMessage` (same defensive shape as the GET
 *      handler — credential bytes never leak to subscribers).
 *   3. The happy path emits NO `pipeline.intake_failed` event.
 *   4. The event fires even when the optional emitter is absent —
 *      i.e. the worker's existing throw + DB-write behavior is
 *      unchanged when no bus is wired (composition-incomplete
 *      shape used in tests without an SSE wiring).
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
import { TransientError } from "@opencoo/shared/errors";
import type { GuardAdapter } from "@opencoo/shared/adapter-contract-tests/guard";

import { runCompilationWorker } from "../../src/pipelines/compilation-worker.js";
import type { ScannerClassifyJob } from "../../src/pipelines/scanner.js";
import type { IngestionRunEventEmitter } from "../../src/workers/context.js";

import { freshPipelineDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

const COMPILER_AUTHOR = {
  name: "opencoo-compiler",
  email: "compiler@opencoo.local",
} as const;

function passThroughGuard(): GuardAdapter {
  return {
    slug: "guard-passthrough-test",
    role: "redaction",
    categories: [],
    patternVersion: "v1-test",
    async classify(input) {
      return { events: [], transformedText: input.text };
    },
  };
}

function throwingGuard(error: Error): GuardAdapter {
  return {
    slug: "guard-throwing-test",
    role: "redaction",
    categories: [],
    patternVersion: "v1-test",
    async classify() {
      throw error;
    },
  };
}

async function makeFixture(provider: LlmProvider): Promise<{
  router: LlmRouter;
  bindingId: string;
  intakeId: string;
  domainId: string;
  wikiAdapter: InMemoryWikiAdapter;
  wikiDeps: WikiWriteDeps;
  db: Awaited<ReturnType<typeof freshPipelineDb>>["db"];
  raw: Awaited<ReturnType<typeof freshPipelineDb>>["raw"];
}> {
  const f = await freshPipelineDb({});
  const router = new LlmRouter({
    db: f.db as unknown as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: {
      paused: () => false,
      pause: () => undefined,
      resume: () => undefined,
    },
    provider,
  });
  const intakeResult = await f.raw.query<{ id: string }>(
    `INSERT INTO ingestion_intake (binding_id, source_doc_id, source_revision, content_hash) VALUES ($1, 'doc-1', 'rev-1', 'hash') RETURNING id`,
    [f.bindingId],
  );
  const intakeId = intakeResult.rows[0]!.id;
  const wikiAdapter = new InMemoryWikiAdapter();
  const wikiDeps: WikiWriteDeps = {
    adapter: wikiAdapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: new InMemoryDeleteCap(),
    logger: silentLogger(),
    clock: () => new Date("2026-04-25T12:00:00Z"),
    instanceId: "test",
  };
  return {
    router,
    bindingId: f.bindingId,
    intakeId,
    domainId: f.domainId,
    wikiAdapter,
    wikiDeps,
    db: f.db,
    raw: f.raw,
  };
}

function buildJob(overrides: {
  bindingId: string;
  intakeId: string;
}): ScannerClassifyJob {
  return {
    bindingId: overrides.bindingId,
    intakeId: overrides.intakeId,
    domainSlug: "test-domain",
    sourceRef: "drive:doc-1",
    contentBase64: Buffer.from("Q3 priorities: distribution.").toString(
      "base64",
    ),
    fetchedAt: "2026-04-25T12:00:00.000Z",
  };
}

/** Build an IngestionRunEventEmitter test double that records every
 *  call. The shape carries both `emitRunEvent` (W3) and the new
 *  `emitIntakeFailed` (W4) so the worker can broadcast both signals
 *  on the same wire. */
function makeBus(): IngestionRunEventEmitter & {
  readonly intakeFailedCalls: Array<{
    readonly bindingId: string;
    readonly intakeId: string;
    readonly errorClass: string;
    readonly errorTextSnippet: string;
  }>;
  readonly runEventCalls: Array<unknown>;
} {
  const intakeFailedCalls: Array<{
    bindingId: string;
    intakeId: string;
    errorClass: string;
    errorTextSnippet: string;
  }> = [];
  const runEventCalls: Array<unknown> = [];
  return {
    emitRunEvent(event): void {
      runEventCalls.push(event);
    },
    emitIntakeFailed(event): void {
      intakeFailedCalls.push({
        bindingId: event.bindingId,
        intakeId: event.intakeId,
        errorClass: event.errorClass,
        errorTextSnippet: event.errorTextSnippet,
      });
    },
    intakeFailedCalls,
    runEventCalls,
  };
}

describe("runCompilationWorker — pipeline.intake_failed SSE event (PR-W4)", () => {
  it("emits pipeline.intake_failed when an OpencooError is caught", async () => {
    const mock = new MockLlmClient();
    const f = await makeFixture(mock);
    const bus = makeBus();

    await expect(
      runCompilationWorker({
        db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router: f.router,
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        guardAdapter: throwingGuard(
          new TransientError("guard upstream timed out"),
        ),
        job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
        sseBus: bus,
      }),
    ).rejects.toThrow(/guard upstream timed out/);

    expect(bus.intakeFailedCalls).toHaveLength(1);
    const evt = bus.intakeFailedCalls[0]!;
    expect(evt.bindingId).toBe(f.bindingId);
    expect(evt.intakeId).toBe(f.intakeId);
    expect(evt.errorClass).toBe("transient");
    expect(evt.errorTextSnippet).toBe("guard upstream timed out");
  });

  it("emits pipeline.intake_failed when a non-OpencooError is caught", async () => {
    const mock = new MockLlmClient();
    const f = await makeFixture(mock);
    const bus = makeBus();

    await expect(
      runCompilationWorker({
        db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router: f.router,
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        guardAdapter: throwingGuard(new Error("boom")),
        job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
        sseBus: bus,
      }),
    ).rejects.toThrow(/boom/);

    expect(bus.intakeFailedCalls).toHaveLength(1);
    expect(bus.intakeFailedCalls[0]?.errorClass).toBe("transient");
    expect(bus.intakeFailedCalls[0]?.errorTextSnippet).toBe("boom");
  });

  it("truncates errorTextSnippet to 200 chars and scrubs credential bytes", async () => {
    const mock = new MockLlmClient();
    const f = await makeFixture(mock);
    const bus = makeBus();

    // 40+ char hex-shaped token caught by scrubPat's generic rule.
    const fakePat = "deadbeef".repeat(8); // 64 hex chars
    const longMessage = `header ${fakePat} ` + "x".repeat(500);

    await expect(
      runCompilationWorker({
        db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router: f.router,
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        guardAdapter: throwingGuard(new Error(longMessage)),
        job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
        sseBus: bus,
      }),
    ).rejects.toThrow();

    expect(bus.intakeFailedCalls).toHaveLength(1);
    const snippet = bus.intakeFailedCalls[0]!.errorTextSnippet;
    // Cap is 200 chars (defensive against W3's 1000-char DB cap).
    expect(snippet.length).toBeLessThanOrEqual(200);
    // PAT must not survive into the snippet (THREAT-MODEL §3.6 inv 11).
    expect(snippet).not.toContain(fakePat);
  });

  it("does NOT emit pipeline.intake_failed on the happy path", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Classifier" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "Q3 priorities",
          target_domains: [
            {
              domain_slug: "test-domain",
              page_paths: ["strategy/q3-2026.md"],
            },
          ],
          pipelines: ["compile.single-source"],
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });
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
    const bus = makeBus();

    await runCompilationWorker({
      db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
      logger: silentLogger(),
      router: f.router,
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      guardAdapter: passThroughGuard(),
      job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
      sseBus: bus,
    });

    expect(bus.intakeFailedCalls).toHaveLength(0);
  });

  it("falls back gracefully when sseBus is undefined (composition-incomplete)", async () => {
    const mock = new MockLlmClient();
    const f = await makeFixture(mock);

    // No bus wired — worker still writes the intake row and throws.
    await expect(
      runCompilationWorker({
        db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router: f.router,
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        guardAdapter: throwingGuard(new Error("no-bus")),
        job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
      }),
    ).rejects.toThrow(/no-bus/);

    // DB-side W3 behavior unchanged: row is `failed`.
    const after = await f.raw.query<{ status: string }>(
      `SELECT status FROM ingestion_intake WHERE id = $1`,
      [f.intakeId],
    );
    expect(after.rows[0]?.status).toBe("failed");
  });

  it("does not break the worker even if emitIntakeFailed throws", async () => {
    const mock = new MockLlmClient();
    const f = await makeFixture(mock);

    // A bus whose emit throws — the worker's catch must still rethrow
    // the ORIGINAL error so BullMQ moves the job to its `failed` set.
    const throwingBus: IngestionRunEventEmitter = {
      emitRunEvent: vi.fn(),
      emitIntakeFailed: vi.fn(() => {
        throw new Error("bus is wedged");
      }),
    };

    await expect(
      runCompilationWorker({
        db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router: f.router,
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        guardAdapter: throwingGuard(new Error("real failure")),
        job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
        sseBus: throwingBus,
      }),
    ).rejects.toThrow(/real failure/);

    expect(throwingBus.emitIntakeFailed).toHaveBeenCalledTimes(1);
  });
});
