/**
 * Surfacer agent tests (PR 21 / plan #102).
 *
 * Pin:
 *   1. Definition shape (slug 'surfacer', read-only tools).
 *   2. Output schema strict Zod (≤10 candidates, every cites
 *      ≥1 wiki page, .strict() rejects unknown fields).
 *   3. Body inserts every (allow-listed) candidate at
 *      status='proposed' via Gate 1 helper.
 *   4. Body skips candidates with unknown template_slug
 *      (defensive — the LLM was told the closed set).
 *   5. Same domainSlug × scopeDomainIds cross-check as
 *      Heartbeat / Lint / Chat.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";

import {
  AgentDefinitionRegistry,
  invokeAgent,
} from "../../src/agent-harness/index.js";
import { InMemoryMcpToolClient } from "../../src/mcp-tool-client/index.js";
import {
  SURFACER_DEFINITION,
  SURFACER_OUTPUT_SCHEMA,
  runSurfacer,
  type SurfacerOutput,
} from "../../src/agents/surfacer/index.js";

import {
  freshAgentDb,
  seedAgentInstance,
} from "../agent-harness/_pglite-fixture.js";

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

describe("SURFACER_DEFINITION", () => {
  it("declares slug='surfacer' and a read-only tool surface", () => {
    expect(SURFACER_DEFINITION.slug).toBe("surfacer");
    for (const name of SURFACER_DEFINITION.toolNames) {
      expect(name).not.toMatch(/^wiki\.write|wiki\.replace|wiki\.delete|wiki\.commit/);
    }
  });

  it("default memory is 'none' (single-shot per cadence)", () => {
    expect(SURFACER_DEFINITION.defaultMemory).toMatchObject({ type: "none" });
  });
});

describe("SURFACER_OUTPUT_SCHEMA — strict Zod", () => {
  it("accepts a valid payload", () => {
    const ok: SurfacerOutput = {
      version: "v1",
      candidates: [
        {
          title: "Q3 deck reminder",
          summary: "Weekly Friday ping for Q3 deck status.",
          template_slug: "weekly-ping",
          params: { day: "Friday" },
          source_page_refs: [
            { domain_slug: "exec", page_path: "projects/q3.md" },
          ],
        },
      ],
    };
    expect(() => SURFACER_OUTPUT_SCHEMA.parse(ok)).not.toThrow();
  });

  it("rejects > 10 candidates", () => {
    const eleven = {
      version: "v1",
      candidates: Array.from({ length: 11 }, (_, i) => ({
        title: `t${i}`,
        summary: "s",
        template_slug: "weekly-ping",
        params: {},
        source_page_refs: [{ domain_slug: "x", page_path: "p.md" }],
      })),
    };
    expect(() => SURFACER_OUTPUT_SCHEMA.parse(eleven)).toThrow();
  });

  it("rejects a candidate with empty source_page_refs", () => {
    const bad = {
      version: "v1",
      candidates: [
        {
          title: "t",
          summary: "s",
          template_slug: "weekly-ping",
          params: {},
          source_page_refs: [] as Array<{ domain_slug: string; page_path: string }>,
        },
      ],
    };
    expect(() => SURFACER_OUTPUT_SCHEMA.parse(bad)).toThrow();
  });

  it("rejects unknown fields (.strict)", () => {
    const bad = {
      version: "v1",
      candidates: [],
      malicious: "ignored?",
    };
    expect(() => SURFACER_OUTPUT_SCHEMA.parse(bad)).toThrow();
  });
});

describe("runSurfacer — Gate 1 (every candidate inserted at status='proposed')", () => {
  it("inserts every allow-listed candidate via Gate 1 helper", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "surfacer",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(SURFACER_DEFINITION);

    const mcp = new InMemoryMcpToolClient();
    mcp.setResource("worldview://test-domain", "# wv");
    mcp.setResource("wiki://test-domain/index.md", "# i");

    const llmPayload: SurfacerOutput = {
      version: "v1",
      candidates: [
        {
          title: "Q3 deck reminder",
          summary: "weekly Friday ping",
          template_slug: "weekly-ping",
          params: { day: "Friday" },
          source_page_refs: [
            { domain_slug: "test-domain", page_path: "index.md" },
          ],
        },
        {
          title: "Stale-bug sweep",
          summary: "monthly sweep of stale bugs",
          template_slug: "monthly-sweep",
          params: { age_days: 30 },
          source_page_refs: [
            { domain_slug: "test-domain", page_path: "index.md" },
          ],
        },
      ],
    };
    const router = makeRouter(fakeProvider(llmPayload), fixture.db);

    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runSurfacer(ctx, {
          db: fixture.db as unknown as Parameters<typeof runSurfacer>[1]["db"],
          mcp,
          domainSlug: "test-domain",
          availableTemplateSlugs: ["weekly-ping", "monthly-sweep"],
        }),
    });

    expect(result.status).toBe("success");
    const output = result.output as Awaited<ReturnType<typeof runSurfacer>>;
    expect(output.insertedCandidateIds).toHaveLength(2);

    // Every inserted row landed at status='proposed' (Gate 1).
    const rows = await fixture.raw.query<{ status: string }>(
      `SELECT status::text AS status FROM automation_candidates`,
    );
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) {
      expect(r.status).toBe("proposed");
    }
  });

  it("skips candidates whose template_slug is not in the allow-list (logs warn)", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "surfacer",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(SURFACER_DEFINITION);
    const mcp = new InMemoryMcpToolClient();
    mcp.setResource("worldview://test-domain", "# wv");
    mcp.setResource("wiki://test-domain/index.md", "# i");

    const llmPayload: SurfacerOutput = {
      version: "v1",
      candidates: [
        {
          title: "Bad template",
          summary: "uses an unknown slug",
          template_slug: "shadow-template", // NOT in allow-list
          params: {},
          source_page_refs: [
            { domain_slug: "test-domain", page_path: "index.md" },
          ],
        },
      ],
    };
    const router = makeRouter(fakeProvider(llmPayload), fixture.db);

    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runSurfacer(ctx, {
          db: fixture.db as unknown as Parameters<typeof runSurfacer>[1]["db"],
          mcp,
          domainSlug: "test-domain",
          availableTemplateSlugs: ["weekly-ping"],
        }),
    });

    expect(result.status).toBe("success");
    const rows = await fixture.raw.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM automation_candidates`,
    );
    expect(rows.rows[0]?.count).toBe("0");
  });

  it("DLQs as validation when domainSlug is not in scope", async () => {
    const fixture = await freshAgentDb();
    await fixture.raw.query(
      `INSERT INTO domains (slug, name) VALUES ('other-domain', 'Other')`,
    );
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "surfacer",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(SURFACER_DEFINITION);
    const mcp = new InMemoryMcpToolClient();
    const router = makeRouter(
      fakeProvider({ version: "v1", candidates: [] }),
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
        runSurfacer(ctx, {
          db: fixture.db as unknown as Parameters<typeof runSurfacer>[1]["db"],
          mcp,
          domainSlug: "other-domain",
          availableTemplateSlugs: ["weekly-ping"],
        }),
    });
    expect(result.status).toBe("failed");
    const rows = await fixture.raw.query<{ output: { name: string } }>(
      `SELECT output FROM agent_runs WHERE id = $1`,
      [result.runId],
    );
    expect(rows.rows[0]?.output?.name).toBe("DomainScopeMismatchError");
  });
});
