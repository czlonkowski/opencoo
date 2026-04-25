/**
 * AgentDefinitionRegistry — in-memory definitions store; UPSERT
 * to agent_definitions table at boot. Concrete agents (PR 20+)
 * call `register()` on this registry.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  AgentDefinitionRegistry,
  syncDefinitions,
  type AgentDefinition,
} from "../../src/agent-harness/index.js";

import { freshAgentDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const HEARTBEAT_DEF: AgentDefinition = {
  slug: "heartbeat",
  version: "1.0.0",
  description: "Daily heartbeat report",
  outputSchemaName: "HeartbeatOutput",
  defaultMemory: { type: "run-history", count: 5 },
};

const LINT_DEF: AgentDefinition = {
  slug: "lint",
  version: "1.0.0",
  description: "Weekly lint pass",
  outputSchemaName: "LintFindings",
  defaultMemory: { type: "none" },
};

describe("AgentDefinitionRegistry", () => {
  it("starts empty", () => {
    const r = new AgentDefinitionRegistry();
    expect(r.size()).toBe(0);
    expect(r.list()).toEqual([]);
  });

  it("registers + retrieves by slug", () => {
    const r = new AgentDefinitionRegistry();
    r.register(HEARTBEAT_DEF);
    expect(r.get("heartbeat")).toBe(HEARTBEAT_DEF);
    expect(r.size()).toBe(1);
  });

  it("preserves insertion order in list()", () => {
    const r = new AgentDefinitionRegistry();
    r.register(HEARTBEAT_DEF);
    r.register(LINT_DEF);
    expect(r.list().map((d) => d.slug)).toEqual(["heartbeat", "lint"]);
  });

  it("rejects duplicate slug — fails loud at boot", () => {
    const r = new AgentDefinitionRegistry();
    r.register(HEARTBEAT_DEF);
    expect(() => r.register({ ...HEARTBEAT_DEF, version: "1.0.1" })).toThrow(
      /duplicate agent definition slug/,
    );
  });

  it("returns undefined for unknown slug", () => {
    expect(new AgentDefinitionRegistry().get("nope")).toBeUndefined();
  });
});

describe("syncDefinitions — UPSERT to agent_definitions table", () => {
  it("inserts new rows for every registered definition", async () => {
    const fixture = await freshAgentDb();
    const r = new AgentDefinitionRegistry();
    r.register(HEARTBEAT_DEF);
    r.register(LINT_DEF);
    await syncDefinitions({
      registry: r,
      db: fixture.db as unknown as Parameters<
        typeof syncDefinitions
      >[0]["db"],
      logger: silentLogger(),
    });
    const rows = await fixture.raw.query<{
      slug: string;
      version: string;
      description: string;
    }>(`SELECT slug, version, description FROM agent_definitions ORDER BY slug`);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.slug).toBe("heartbeat");
    expect(rows.rows[1]?.slug).toBe("lint");
  });

  it("updates the version + updated_at on re-registration (mutation-adjacent)", async () => {
    const fixture = await freshAgentDb();
    const r1 = new AgentDefinitionRegistry();
    r1.register(HEARTBEAT_DEF);
    await syncDefinitions({
      registry: r1,
      db: fixture.db as unknown as Parameters<
        typeof syncDefinitions
      >[0]["db"],
      logger: silentLogger(),
    });
    const r2 = new AgentDefinitionRegistry();
    r2.register({ ...HEARTBEAT_DEF, version: "1.1.0" });
    await syncDefinitions({
      registry: r2,
      db: fixture.db as unknown as Parameters<
        typeof syncDefinitions
      >[0]["db"],
      logger: silentLogger(),
    });
    const rows = await fixture.raw.query<{ version: string }>(
      `SELECT version FROM agent_definitions WHERE slug = 'heartbeat'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.version).toBe("1.1.0");
  });

  it("preserves default_memory JSON on insert", async () => {
    const fixture = await freshAgentDb();
    const r = new AgentDefinitionRegistry();
    r.register(HEARTBEAT_DEF);
    await syncDefinitions({
      registry: r,
      db: fixture.db as unknown as Parameters<
        typeof syncDefinitions
      >[0]["db"],
      logger: silentLogger(),
    });
    const rows = await fixture.raw.query<{ default_memory: unknown }>(
      `SELECT default_memory FROM agent_definitions WHERE slug = 'heartbeat'`,
    );
    expect(rows.rows[0]?.default_memory).toEqual({
      type: "run-history",
      count: 5,
    });
  });
});
