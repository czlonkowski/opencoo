/**
 * Run recorder — startRun INSERT + completeRun guarded UPDATE.
 *
 * THE LOAD-BEARING TESTS (Q11 carve-out per plan #87):
 *   - completeRun's SQL includes WHERE status='running' so the
 *     UPDATE can NEVER mutate a terminal row.
 *   - A second completeRun() against an already-terminal row
 *     returns 0 rows affected and throws
 *     AgentRunAlreadyTerminalError (validation class → DLQ).
 *   - The amended THREAT-MODEL §2 invariant 8 wording is the
 *     contract this carve-out enforces.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  AgentRunAlreadyTerminalError,
  completeRun,
  startRun,
} from "../../src/agent-harness/index.js";

import { freshAgentDb, seedAgentInstance } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

describe("startRun", () => {
  it("inserts a row with status='running' and returns the new id", async () => {
    const fixture = await freshAgentDb();
    const { instanceId, definitionSlug } = await seedAgentInstance(fixture);
    const { runId, startedAt } = await startRun({
      db: fixture.db as unknown as Parameters<typeof startRun>[0]["db"],
      definitionSlug,
      instanceId,
      trigger: "scheduled",
      inputs: { key: "value" },
    });
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(startedAt).toBeInstanceOf(Date);
    const rows = await fixture.raw.query<{
      status: string;
      definition_slug: string;
      inputs: unknown;
    }>(
      `SELECT status::text AS status, definition_slug, inputs FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(rows.rows[0]?.status).toBe("running");
    expect(rows.rows[0]?.definition_slug).toBe(definitionSlug);
    expect(rows.rows[0]?.inputs).toEqual({ key: "value" });
  });
});

describe("completeRun — happy path", () => {
  it("terminalizes a running row to status='success' with terminal columns set", async () => {
    const fixture = await freshAgentDb();
    const { instanceId, definitionSlug } = await seedAgentInstance(fixture);
    const { runId } = await startRun({
      db: fixture.db as unknown as Parameters<typeof startRun>[0]["db"],
      definitionSlug,
      instanceId,
      trigger: "scheduled",
      inputs: {},
    });
    await completeRun({
      db: fixture.db as unknown as Parameters<typeof completeRun>[0]["db"],
      logger: silentLogger(),
      runId,
      status: "success",
      output: { ok: true },
      toolCalls: [
        { name: "wiki.read_page", args: { path: "x.md" }, durationMs: 12 },
      ],
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.000125,
      latencyMs: 1234,
    });
    const rows = await fixture.raw.query<{
      status: string;
      tokens_in: number;
      tokens_out: number;
      latency_ms: number;
      output: unknown;
      tool_calls: unknown;
      ended_at: string | null;
    }>(
      `SELECT status::text AS status, tokens_in, tokens_out, latency_ms, output, tool_calls, ended_at FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(rows.rows[0]?.status).toBe("success");
    expect(rows.rows[0]?.tokens_in).toBe(100);
    expect(rows.rows[0]?.tokens_out).toBe(50);
    expect(rows.rows[0]?.latency_ms).toBe(1234);
    expect(rows.rows[0]?.output).toEqual({ ok: true });
    expect(rows.rows[0]?.ended_at).not.toBeNull();
  });

  it("supports terminal status 'failed' + errorClass", async () => {
    const fixture = await freshAgentDb();
    const { instanceId, definitionSlug } = await seedAgentInstance(fixture);
    const { runId } = await startRun({
      db: fixture.db as unknown as Parameters<typeof startRun>[0]["db"],
      definitionSlug,
      instanceId,
      trigger: "http",
      inputs: {},
    });
    await completeRun({
      db: fixture.db as unknown as Parameters<typeof completeRun>[0]["db"],
      logger: silentLogger(),
      runId,
      status: "failed",
      output: { error: "boom" },
      toolCalls: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: 5,
      errorClass: "transient",
    });
    const rows = await fixture.raw.query<{
      status: string;
      error_class: string | null;
    }>(
      `SELECT status::text AS status, error_class::text AS error_class FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(rows.rows[0]?.status).toBe("failed");
    expect(rows.rows[0]?.error_class).toBe("transient");
  });
});

describe("completeRun — LOAD-BEARING WHERE status='running' guard (plan #87 Q11)", () => {
  it("a second completeRun on an already-terminal row throws AgentRunAlreadyTerminalError", async () => {
    const fixture = await freshAgentDb();
    const { instanceId, definitionSlug } = await seedAgentInstance(fixture);
    const { runId } = await startRun({
      db: fixture.db as unknown as Parameters<typeof startRun>[0]["db"],
      definitionSlug,
      instanceId,
      trigger: "mcp",
      inputs: {},
    });
    await completeRun({
      db: fixture.db as unknown as Parameters<typeof completeRun>[0]["db"],
      logger: silentLogger(),
      runId,
      status: "success",
      output: { first: true },
      toolCalls: [],
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0,
      latencyMs: 1,
    });

    // Second call must refuse — terminal rows are append-only.
    await expect(
      completeRun({
        db: fixture.db as unknown as Parameters<typeof completeRun>[0]["db"],
        logger: silentLogger(),
        runId,
        status: "failed",
        output: { second: "should-not-land" },
        toolCalls: [],
        tokensIn: 99,
        tokensOut: 99,
        costUsd: 0,
        latencyMs: 1,
      }),
    ).rejects.toBeInstanceOf(AgentRunAlreadyTerminalError);

    // The row's terminal-state stayed first-write-wins.
    const rows = await fixture.raw.query<{
      status: string;
      output: unknown;
      tokens_in: number;
    }>(
      `SELECT status::text AS status, output, tokens_in FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(rows.rows[0]?.status).toBe("success");
    expect(rows.rows[0]?.output).toEqual({ first: true });
    expect(rows.rows[0]?.tokens_in).toBe(10);
  });

  it("a completeRun against a non-existent runId throws AgentRunAlreadyTerminalError (0 rows affected)", async () => {
    const fixture = await freshAgentDb();
    await expect(
      completeRun({
        db: fixture.db as unknown as Parameters<typeof completeRun>[0]["db"],
        logger: silentLogger(),
        runId: "00000000-0000-0000-0000-000000000000",
        status: "success",
        output: {},
        toolCalls: [],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs: 0,
      }),
    ).rejects.toBeInstanceOf(AgentRunAlreadyTerminalError);
  });

  it("AgentRunAlreadyTerminalError carries the runId + validation class", async () => {
    const fixture = await freshAgentDb();
    const { instanceId, definitionSlug } = await seedAgentInstance(fixture);
    const { runId } = await startRun({
      db: fixture.db as unknown as Parameters<typeof startRun>[0]["db"],
      definitionSlug,
      instanceId,
      trigger: "scheduled",
      inputs: {},
    });
    await completeRun({
      db: fixture.db as unknown as Parameters<typeof completeRun>[0]["db"],
      logger: silentLogger(),
      runId,
      status: "success",
      output: {},
      toolCalls: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: 0,
    });
    try {
      await completeRun({
        db: fixture.db as unknown as Parameters<typeof completeRun>[0]["db"],
        logger: silentLogger(),
        runId,
        status: "failed",
        output: {},
        toolCalls: [],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs: 0,
      });
      expect.fail("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentRunAlreadyTerminalError);
      const e = err as AgentRunAlreadyTerminalError;
      expect(e.runId).toBe(runId);
      expect(e.errorClass).toBe("validation");
    }
  });
});
