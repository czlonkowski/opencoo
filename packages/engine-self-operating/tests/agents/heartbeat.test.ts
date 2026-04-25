/**
 * Heartbeat agent — proactive daily briefing.
 *
 * Read-only. Produces a JSON payload (summary + ≤5 alerts,
 * lead with priority-1, every alert cites a wiki path). The
 * engine post-run hook routes the payload via
 * `OutputChannelRegistry.deliver` to the bound channels; the
 * agent itself never delivers and never writes wiki content.
 *
 * Tests pin the load-bearing invariants:
 *   1. Definition shape — slug 'heartbeat', outputSchemaName,
 *      defaultMemory.
 *   2. Output schema — strict Zod with the priority/title/body/
 *      citations contract; the LLM's reply is parsed via
 *      router.generateObject so a malformed shape DLQs as
 *      validation.
 *   3. Body wires the three reader tools through ctx.callTool
 *      (deny-list + ledger fire) and uses indexSearch to ground
 *      citations.
 *   4. Body NEVER calls a writer tool — cross-checked by an
 *      InMemoryWikiAdapter shared with the integration test
 *      that asserts wikiWrite has 0 calls.
 *   5. Locale resolves through loadPrompt — instance.locale=pl
 *      pulls the PL prompt body; auto/unknown falls back to en.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router/testing";

import {
  AgentDefinitionRegistry,
  invokeAgent,
} from "../../src/agent-harness/index.js";
import { InMemoryMcpToolClient } from "../../src/mcp-tool-client/index.js";
import {
  HEARTBEAT_DEFINITION,
  HEARTBEAT_OUTPUT_SCHEMA,
  runHeartbeat,
  type HeartbeatOutput,
} from "../../src/agents/heartbeat/index.js";

import { freshAgentDb, seedAgentInstance } from "../agent-harness/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
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

describe("HEARTBEAT_DEFINITION — agent definition shape", () => {
  it("declares slug='heartbeat', outputSchemaName='HeartbeatOutput'", () => {
    expect(HEARTBEAT_DEFINITION.slug).toBe("heartbeat");
    expect(HEARTBEAT_DEFINITION.outputSchemaName).toBe("HeartbeatOutput");
  });

  it("default memory is 'run-history' so the agent sees its prior briefings (architecture §9.4)", () => {
    expect(HEARTBEAT_DEFINITION.defaultMemory).toMatchObject({
      type: "run-history",
    });
  });
});

describe("HEARTBEAT_OUTPUT_SCHEMA — strict Zod contract", () => {
  it("accepts a valid payload with summary + alerts (priority/title/body/citations)", () => {
    const ok: HeartbeatOutput = {
      version: "v1",
      summary: "Yesterday: shipped X.",
      alerts: [
        {
          priority: 1,
          title: "Q3 deck due Friday",
          body: "Sales asked for Q3 deck.",
          citations: ["projects/q3.md"],
        },
      ],
    };
    expect(() => HEARTBEAT_OUTPUT_SCHEMA.parse(ok)).not.toThrow();
  });

  it("rejects an alert without citations (every alert must cite at least one wiki path)", () => {
    const bad = {
      version: "v1",
      summary: "x",
      alerts: [
        { priority: 1, title: "t", body: "b", citations: [] as string[] },
      ],
    };
    expect(() => HEARTBEAT_OUTPUT_SCHEMA.parse(bad)).toThrow();
  });

  it("rejects more than 5 alerts (architecture §9.4 cap)", () => {
    const six = {
      version: "v1",
      summary: "x",
      alerts: Array.from({ length: 6 }, (_, i) => ({
        priority: i + 1,
        title: `t${i}`,
        body: "b",
        citations: ["a.md"],
      })),
    };
    expect(() => HEARTBEAT_OUTPUT_SCHEMA.parse(six)).toThrow();
  });

  it("rejects a payload whose first alert is not priority=1 (lead with priority-1)", () => {
    const bad = {
      version: "v1",
      summary: "x",
      alerts: [
        { priority: 2, title: "t", body: "b", citations: ["a.md"] },
      ],
    };
    expect(() => HEARTBEAT_OUTPUT_SCHEMA.parse(bad)).toThrow();
  });

  it("accepts an empty alerts array (a valid 'nothing to surface' day)", () => {
    const empty: HeartbeatOutput = {
      version: "v1",
      summary: "All quiet.",
      alerts: [],
    };
    expect(() => HEARTBEAT_OUTPUT_SCHEMA.parse(empty)).not.toThrow();
  });
});

describe("runHeartbeat — body wires McpToolClient via ctx.callTool", () => {
  function mockProvider(payload: HeartbeatOutput): LlmProvider {
    return {
      generate: async () => ({
        text: JSON.stringify(payload),
        tokensIn: 10,
        tokensOut: 20,
      }),
    };
  }

  it("invokes index.search to ground its briefing and returns the schema-validated output", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "heartbeat",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(HEARTBEAT_DEFINITION);

    const mcp = new InMemoryMcpToolClient();
    mcp.setResource("wiki://test-domain/index.md", "# index");
    mcp.setResource("wiki://test-domain/projects/q3.md", "# q3");
    mcp.setResource("worldview://test-domain", "# wv");

    const payload: HeartbeatOutput = {
      version: "v1",
      summary: "Q3 deck due.",
      alerts: [
        {
          priority: 1,
          title: "Q3 deck due Friday",
          body: "Sales blocked on the deck.",
          citations: ["projects/q3.md"],
        },
      ],
    };
    const router = makeRouter(mockProvider(payload), fixture.db);

    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) => runHeartbeat(ctx, { mcp, domainSlug: "test-domain" }),
    });

    expect(result.status).toBe("success");
    expect(result.output).toEqual(payload);

    // The body must have called index.search + worldview.read
    // through the harness, so the tool ledger has at least
    // those two entries.
    const rows = await fixture.raw.query<{
      tool_calls: Array<{ name: string }>;
    }>(`SELECT tool_calls FROM agent_runs WHERE id = $1`, [result.runId]);
    const names = (rows.rows[0]?.tool_calls ?? []).map((c) => c.name);
    expect(names).toContain("index.search");
    expect(names).toContain("worldview.read");
  });

  it("DLQs as validation when the LLM returns a payload with too many alerts", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "heartbeat",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(HEARTBEAT_DEFINITION);

    const mcp = new InMemoryMcpToolClient();
    mcp.setResource("wiki://test-domain/index.md", "# index");
    mcp.setResource("worldview://test-domain", "# wv");

    const overflow = {
      version: "v1",
      summary: "x",
      alerts: Array.from({ length: 6 }, (_, i) => ({
        priority: i + 1,
        title: `t${i}`,
        body: "b",
        citations: ["a.md"],
      })),
    };
    const router = makeRouter(mockProvider(overflow as HeartbeatOutput), fixture.db);

    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) => runHeartbeat(ctx, { mcp, domainSlug: "test-domain" }),
    });

    expect(result.status).toBe("failed");
    const rows = await fixture.raw.query<{ error_class: string }>(
      `SELECT error_class::text AS error_class FROM agent_runs WHERE id = $1`,
      [result.runId],
    );
    expect(rows.rows[0]?.error_class).toBe("validation");
  });
});
