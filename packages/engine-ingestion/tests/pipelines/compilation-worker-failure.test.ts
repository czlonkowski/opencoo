/**
 * Compilation Worker — failure capture (PR-W3, phase-a appendix #14).
 *
 * Before W3, the worker dropped all exceptions out to BullMQ without
 * touching the intake row, leaving rows pinned at `status='pending'`
 * forever even though their jobs were in the BullMQ `failed` set —
 * the design-partner deployment ran with ~260 such ghost rows for
 * 20+ hours after the classifier guard started rejecting wildcard-
 * only bindings.
 *
 * These tests pin the new behavior:
 *   1. `OpencooError` thrown from the body (e.g. `BindingConfigError`
 *      raised by `assertBindingNotWildcardOnly` inside `classify()`)
 *      lands `status='failed', error_class=<kind>, error_text=<msg>`
 *      on the intake row BEFORE BullMQ sees the re-throw.
 *   2. A non-`OpencooError` throw (e.g. an unexpected runtime error
 *      from a downstream dependency) lands
 *      `status='failed', error_class='transient', error_text=<msg>` —
 *      `transient` is the safe default since we cannot classify the
 *      cause and a one-shot retry is cheap.
 *   3. The happy path still sets `status='classified'` with no error
 *      fields populated.
 *   4. `OpencooError` with `errorClass='transient'` lands the same
 *      shape as case (1) but with `error_class='transient'`.
 *
 * In all failure cases the wrapper re-throws so BullMQ still moves
 * the job to its `failed` set (no behavioral change at the queue
 * boundary; the only change is the intake row now reflects truth).
 */
import { describe, expect, it } from "vitest";

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

/** Guard adapter that always throws the supplied error from its
 *  `.classify()` call. Used here to force a failure from a
 *  controlled point inside the worker body — the guard is invoked
 *  unconditionally before the contentKind dispatch, so any
 *  exception it raises is the cleanest way to exercise the
 *  worker's catch block without coupling tests to internal
 *  classifier behavior. */
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

interface IntakeRow {
  status: string;
  error_class: string | null;
  error_text: string | null;
}

async function readIntake(
  raw: Awaited<ReturnType<typeof freshPipelineDb>>["raw"],
  intakeId: string,
): Promise<IntakeRow> {
  const after = await raw.query<IntakeRow>(
    `SELECT status, error_class, error_text FROM ingestion_intake WHERE id = $1`,
    [intakeId],
  );
  expect(after.rows[0]).toBeDefined();
  return after.rows[0]!;
}

describe("runCompilationWorker — failure capture (PR-W3)", () => {
  it("captures BindingConfigError on the intake row before re-throwing", async () => {
    const mock = new MockLlmClient();
    const f = await makeFixture(mock);

    // Force the classifier-level binding guard to fire by clearing
    // `allowed_paths` to the empty array — `assertBindingNotWildcardOnly`
    // raises a `BindingConfigError` (extends OpencooError, kind='validation')
    // before any LLM call, mirroring the production failure mode
    // that hung 260 partner-deployment rows at `pending`.
    await f.raw.query(
      `UPDATE sources_bindings SET allowed_paths = $1 WHERE id = $2`,
      [[], f.bindingId],
    );

    await expect(
      runCompilationWorker({
        db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router: f.router,
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        guardAdapter: passThroughGuard(),
        job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
      }),
    ).rejects.toThrow(/binding\.allowed_paths is empty/);

    const row = await readIntake(f.raw, f.intakeId);
    expect(row.status).toBe("failed");
    expect(row.error_class).toBe("validation");
    expect(row.error_text).toMatch(/binding\.allowed_paths is empty/);
  });

  it("captures OpencooError with errorClass='transient' on the intake row", async () => {
    const mock = new MockLlmClient();
    const f = await makeFixture(mock);

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
      }),
    ).rejects.toThrow(/guard upstream timed out/);

    const row = await readIntake(f.raw, f.intakeId);
    expect(row.status).toBe("failed");
    expect(row.error_class).toBe("transient");
    expect(row.error_text).toBe("guard upstream timed out");
  });

  it("captures unknown (non-Opencoo) errors as error_class='transient'", async () => {
    const mock = new MockLlmClient();
    const f = await makeFixture(mock);

    await expect(
      runCompilationWorker({
        db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router: f.router,
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        guardAdapter: throwingGuard(new Error("boom")),
        job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
      }),
    ).rejects.toThrow(/boom/);

    const row = await readIntake(f.raw, f.intakeId);
    expect(row.status).toBe("failed");
    expect(row.error_class).toBe("transient");
    expect(row.error_text).toBe("boom");
  });

  it("truncates error_text to 1000 chars to bound row size + downstream LLM exposure", async () => {
    const mock = new MockLlmClient();
    const f = await makeFixture(mock);
    const longMessage = "x".repeat(5000);

    await expect(
      runCompilationWorker({
        db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router: f.router,
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        guardAdapter: throwingGuard(new Error(longMessage)),
        job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
      }),
    ).rejects.toThrow();

    const row = await readIntake(f.raw, f.intakeId);
    expect(row.status).toBe("failed");
    expect(row.error_text).not.toBeNull();
    expect(row.error_text!.length).toBe(1000);
    expect(row.error_text!.startsWith("x")).toBe(true);
  });

  it("clears error_class/error_text on a fail-then-retry-success sequence (PR-W3 Copilot triage)", async () => {
    // Models the production flow the wave-14 plan documents: a
    // binding initially fails (e.g. empty `allowed_paths`); operator
    // fixes the config via the W1 PATCH route; W2 re-enqueues the
    // job; the same intake row should land at `classified` with NO
    // stale error fields. Without the success-path clear, the W4
    // UI panel + W6 system-health gatherer would surface a ghost
    // failure on a row that actually succeeded on retry.
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

    // First run — empty allowed_paths triggers BindingConfigError.
    await f.raw.query(
      `UPDATE sources_bindings SET allowed_paths = $1 WHERE id = $2`,
      [[], f.bindingId],
    );
    await expect(
      runCompilationWorker({
        db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router: f.router,
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        guardAdapter: passThroughGuard(),
        job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
      }),
    ).rejects.toThrow();
    const failedRow = await readIntake(f.raw, f.intakeId);
    expect(failedRow.status).toBe("failed");
    expect(failedRow.error_class).toBe("validation");
    expect(failedRow.error_text).not.toBeNull();

    // Second run — operator backfilled `allowed_paths`; retry succeeds.
    await f.raw.query(
      `UPDATE sources_bindings SET allowed_paths = $1 WHERE id = $2`,
      [["strategy/**", "executive/**"], f.bindingId],
    );
    await runCompilationWorker({
      db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
      logger: silentLogger(),
      router: f.router,
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      guardAdapter: passThroughGuard(),
      job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
    });
    const finalRow = await readIntake(f.raw, f.intakeId);
    expect(finalRow.status).toBe("classified");
    expect(finalRow.error_class).toBeNull();
    expect(finalRow.error_text).toBeNull();
  });

  it("leaves error_class/error_text untouched and sets status='classified' on the happy path", async () => {
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
    await runCompilationWorker({
      db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
      logger: silentLogger(),
      router: f.router,
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      guardAdapter: passThroughGuard(),
      job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
    });

    const row = await readIntake(f.raw, f.intakeId);
    expect(row.status).toBe("classified");
    expect(row.error_class).toBeNull();
    expect(row.error_text).toBeNull();
  });
});
