/**
 * Lint orchestrator integration test. Drives `runLint` via
 * `invokeAgent` end-to-end with seeded bindings + citations +
 * MCP-backed wiki content. Assertions:
 *   1. Wildcard-bindings detector fires for a `["**"]` binding.
 *   2. Stale-pages detector fires for a citation older than the
 *      threshold.
 *   3. Orphans detector fires for a wiki path with no citation.
 *   4. Prompt-version-drift detector fires when the seeded
 *      citation's prompt_version lags the loader's current.
 *   5. Contradictions detector flows through the LLM mock.
 *   6. The agent run terminalizes as success and the
 *      LintOutput payload is the agent_runs.output.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";

import {
  AgentDefinitionRegistry,
  invokeAgent,
} from "../../../src/agent-harness/index.js";
import { InMemoryMcpToolClient } from "../../../src/mcp-tool-client/index.js";
import {
  LINT_DEFINITION,
  runLint,
  type LintOutput,
} from "../../../src/agents/lint/index.js";

import {
  freshAgentDb,
  seedAgentInstance,
  seedBinding,
  seedPageCitation,
} from "../../agent-harness/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function fakeProvider(payload: unknown): LlmProvider {
  return {
    generate: async () => ({
      text: JSON.stringify(payload),
      tokensIn: 5,
      tokensOut: 5,
    }),
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

describe("runLint — end-to-end orchestrator", () => {
  it("fans out to all 5 detectors and surfaces their findings via agent_runs.output", async () => {
    const fixture = await freshAgentDb();

    // 1. Wildcard binding (will trigger wildcard-bindings).
    await seedBinding(fixture, { allowedPaths: ["**"] });
    // 2. Narrow binding so we have a non-wildcard FK target for
    //    citations that should NOT trigger wildcard-bindings.
    const narrow = await seedBinding(fixture, {
      adapterSlug: "asana",
      allowedPaths: ["projects/q3.md"],
    });

    // 3. Stale citation (>90 days old, default threshold).
    await seedPageCitation(fixture, {
      pagePath: "projects/q3.md",
      bindingId: narrow.bindingId,
      promptVersion: "1.0.0",
      createdSecondsAgo: 100 * 86_400,
    });
    // 4. Fresh citation, but with stale prompt_version.
    await seedPageCitation(fixture, {
      pagePath: "team/eng.md",
      bindingId: narrow.bindingId,
      promptVersion: "0.0.1-stale",
    });

    // 5. Wiki paths via MCP — `team/eng.md` is cited (test prompt-
    //    drift), `projects/q3.md` is cited (test stale-pages) but
    //    `orphan.md` is NOT cited (test orphans).
    const mcp = new InMemoryMcpToolClient();
    mcp.setResource("wiki://test-domain/team/eng.md", "Python 3.11");
    mcp.setResource("wiki://test-domain/projects/q3.md", "due Friday");
    mcp.setResource("wiki://test-domain/orphan.md", "hand-edited");

    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "lint",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(LINT_DEFINITION);

    // Contradictions LLM mock — emit one finding so we can assert
    // the detector fired.
    const router = makeRouter(
      fakeProvider({
        version: "v1",
        contradictions: [
          {
            page_a: "team/eng.md",
            page_b: "projects/q3.md",
            claim_a: "Python 3.11",
            claim_b: "due Friday",
            severity: "low",
            rationale: "demo contradiction injected by mock",
          },
        ],
      }),
      fixture.db,
    );

    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runLint(ctx, {
          db: fixture.db as unknown as Parameters<typeof runLint>[1]["db"],
          mcp,
          domainSlug: "test-domain",
        }),
    });

    expect(result.status).toBe("success");
    const output = result.output as LintOutput;
    expect(output.version).toBe("v1");

    const kinds = new Set(output.findings.map((f) => f.kind));
    expect(kinds.has("wildcard_bindings")).toBe(true);
    expect(kinds.has("stale_pages")).toBe(true);
    expect(kinds.has("orphans")).toBe(true);
    expect(kinds.has("prompt_version_drift")).toBe(true);
    expect(kinds.has("contradictions")).toBe(true);

    // The orphan we seeded is the one Lint should call out
    // (and NOT index.md / worldview.md / etc., which are exempt).
    const orphanScopes = output.findings
      .filter((f) => f.kind === "orphans")
      .map((f) => f.scope);
    expect(orphanScopes).toContain("test-domain:orphan.md");
  });

  // Same security-adjacent contract as Heartbeat: the agent
  // reads from `args.domainSlug` (caller-supplied) but routes
  // the contradictions LLM call against
  // `ctx.instance.scopeDomainIds[0]`. A miswired caller — or
  // attacker-influenced args — could otherwise lint domain-A's
  // wiki content while billing under domain-B's llm_policy.
  // The body must throw `DomainScopeMismatchError` (validation
  // → DLQ) BEFORE any LLM call or DB query for bindings.
  it("throws DomainScopeMismatchError when domainSlug resolves to an id NOT in scopeDomainIds (copilot #22)", async () => {
    const fixture = await freshAgentDb();
    await fixture.raw.query(
      `INSERT INTO domains (slug, name) VALUES ('other-domain', 'Other')`,
    );
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "lint",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(LINT_DEFINITION);
    const mcp = new InMemoryMcpToolClient();
    const router = makeRouter(
      fakeProvider({ version: "v1", contradictions: [] }),
      fixture.db,
    );
    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runLint(ctx, {
          db: fixture.db as unknown as Parameters<typeof runLint>[1]["db"],
          mcp,
          domainSlug: "other-domain",
        }),
    });
    expect(result.status).toBe("failed");
    const rows = await fixture.raw.query<{
      error_class: string;
      output: { name: string };
    }>(
      `SELECT error_class::text AS error_class, output FROM agent_runs WHERE id = $1`,
      [result.runId],
    );
    expect(rows.rows[0]?.error_class).toBe("validation");
    expect(rows.rows[0]?.output?.name).toBe("DomainScopeMismatchError");
  });

  it("throws DomainScopeMismatchError when the domain slug does not exist (copilot #22)", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "lint",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(LINT_DEFINITION);
    const mcp = new InMemoryMcpToolClient();
    const router = makeRouter(
      fakeProvider({ version: "v1", contradictions: [] }),
      fixture.db,
    );
    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runLint(ctx, {
          db: fixture.db as unknown as Parameters<typeof runLint>[1]["db"],
          mcp,
          domainSlug: "ghost-domain",
        }),
    });
    expect(result.status).toBe("failed");
    const rows = await fixture.raw.query<{ output: { name: string } }>(
      `SELECT output FROM agent_runs WHERE id = $1`,
      [result.runId],
    );
    expect(rows.rows[0]?.output?.name).toBe("DomainScopeMismatchError");
  });

  it("returns an empty findings array when the domain has no bindings, no pages, no citations", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "lint",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(LINT_DEFINITION);

    // No wiki pages, no citations.
    const mcp = new InMemoryMcpToolClient();
    // Contradictions detector won't fire (less than 2 pages); the
    // other 4 also won't fire since their inputs are empty.
    const router = makeRouter(
      fakeProvider({ version: "v1", contradictions: [] }),
      fixture.db,
    );

    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runLint(ctx, {
          db: fixture.db as unknown as Parameters<typeof runLint>[1]["db"],
          mcp,
          domainSlug: "test-domain",
        }),
    });

    expect(result.status).toBe("success");
    const output = result.output as LintOutput;
    expect(output.findings).toEqual([]);
  });
});
