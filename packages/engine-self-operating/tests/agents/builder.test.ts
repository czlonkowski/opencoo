/**
 * Builder agent tests (PR 21 / plan #102).
 *
 * Pin:
 *   1. Definition shape (slug 'builder', read-only tools).
 *   2. Output schema strict Zod (.strict() rejects unknown
 *      fields; no 'activated' anywhere).
 *   3. Body refuses to run on a non-approved candidate
 *      (Gate 2 BuilderGate2Error → DLQ as validation).
 *   4. Body deploys via AutomationAdapter, persists the
 *      deployment row at status='deployed' (Gate 3 — no
 *      'activated' status is ever written), flips the
 *      candidate to 'built'.
 *   5. Body refuses LLM-mismatched candidate_id /
 *      template_slug (hallucination guard).
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";

import {
  AgentDefinitionRegistry,
  invokeAgent,
} from "../../src/agent-harness/index.js";
import {
  BUILDER_DEFINITION,
  BUILDER_OUTPUT_SCHEMA,
  runBuilder,
  type BuilderOutput,
} from "../../src/agents/builder/index.js";
import { InMemoryAutomationAdapter } from "../../src/automation-adapter/index.js";
import { insertCandidate } from "../../src/automation-loop/index.js";

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

const FIXTURE_PROPOSAL = {
  title: "Q3 deck reminder",
  summary: "weekly Friday ping",
  template_slug: "weekly-ping",
  params: { day: "Friday" },
};

async function seedApprovedCandidate(
  fixture: Awaited<ReturnType<typeof freshAgentDb>>,
): Promise<{
  readonly candidateId: string;
  readonly builderInstanceId: string;
}> {
  const { instanceId: surfacerInstanceId } = await seedAgentInstance(fixture, {
    definitionSlug: "surfacer",
    instanceName: "surfacer-1",
  });
  const surfacerRun = await fixture.raw.query<{ id: string }>(
    `INSERT INTO agent_runs (definition_slug, instance_id, trigger, status,
                              started_at, ended_at, created_at)
     VALUES ('surfacer', $1::uuid, 'scheduled', 'success', NOW(), NOW(), NOW())
     RETURNING id::text AS id`,
    [surfacerInstanceId],
  );
  const { candidateId } = await insertCandidate({
    db: fixture.db as unknown as Parameters<typeof insertCandidate>[0]["db"],
    surfacerRunId: surfacerRun.rows[0]!.id,
    sourcePageRefs: [{ domain_slug: "test-domain", page_path: "p.md" }],
    proposal: FIXTURE_PROPOSAL,
  });
  // Operator approval.
  await fixture.raw.query(
    `UPDATE automation_candidates SET status = 'approved' WHERE id = $1::uuid`,
    [candidateId],
  );
  const { instanceId: builderInstanceId } = await seedAgentInstance(fixture, {
    definitionSlug: "builder",
    instanceName: "builder-1",
    memory: { type: "none" },
  });
  return { candidateId, builderInstanceId };
}

describe("BUILDER_DEFINITION", () => {
  it("declares slug='builder' and a read-only tool surface", () => {
    expect(BUILDER_DEFINITION.slug).toBe("builder");
    for (const name of BUILDER_DEFINITION.toolNames) {
      expect(name).not.toMatch(/^wiki\.write|wiki\.replace|wiki\.delete/);
    }
  });
});

describe("BUILDER_OUTPUT_SCHEMA — strict Zod, NO activation field", () => {
  it("accepts a valid v0.1 happy-path payload (skills_used: [])", () => {
    const ok: BuilderOutput = {
      version: "v1",
      build: {
        candidate_id: "00000000-0000-0000-0000-000000000001",
        template_slug: "weekly-ping",
        resolved_params: { day: "Friday" },
        skills_used: [],
      },
    };
    expect(() => BUILDER_OUTPUT_SCHEMA.parse(ok)).not.toThrow();
  });

  it("rejects an 'activated' field anywhere — Gate 3 schema-level defense", () => {
    const bad = {
      version: "v1",
      build: {
        candidate_id: "00000000-0000-0000-0000-000000000001",
        template_slug: "weekly-ping",
        resolved_params: {},
        skills_used: [],
        activated: true, // INVALID
      },
    };
    expect(() => BUILDER_OUTPUT_SCHEMA.parse(bad)).toThrow();
  });

  it("rejects unknown fields at the top level (.strict)", () => {
    const bad = {
      version: "v1",
      build: {
        candidate_id: "00000000-0000-0000-0000-000000000001",
        template_slug: "weekly-ping",
        resolved_params: {},
        skills_used: [],
      },
      malicious: "ignored?",
    };
    expect(() => BUILDER_OUTPUT_SCHEMA.parse(bad)).toThrow();
  });

  it("rejects a skills_used entry missing any of the 4 required fields", () => {
    const bad = {
      version: "v1",
      build: {
        candidate_id: "00000000-0000-0000-0000-000000000001",
        template_slug: "weekly-ping",
        resolved_params: {},
        skills_used: [
          { slug: "x", version: "1.0.0" /* missing sha + source */ },
        ],
      },
    };
    expect(() => BUILDER_OUTPUT_SCHEMA.parse(bad)).toThrow();
  });
});

describe("runBuilder — Gate 2 (refuses non-approved candidates)", () => {
  it("DLQs as validation when the candidate is still 'proposed'", async () => {
    const fixture = await freshAgentDb();
    // Seed a candidate at status='proposed' (NOT approved).
    const { instanceId: surfacerInstanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "surfacer",
      instanceName: "surfacer-1",
    });
    const surfacerRun = await fixture.raw.query<{ id: string }>(
      `INSERT INTO agent_runs (definition_slug, instance_id, trigger, status,
                                started_at, ended_at, created_at)
       VALUES ('surfacer', $1::uuid, 'scheduled', 'success', NOW(), NOW(), NOW())
       RETURNING id::text AS id`,
      [surfacerInstanceId],
    );
    const { candidateId } = await insertCandidate({
      db: fixture.db as unknown as Parameters<typeof insertCandidate>[0]["db"],
      surfacerRunId: surfacerRun.rows[0]!.id,
      sourcePageRefs: [{ domain_slug: "test-domain", page_path: "p.md" }],
      proposal: FIXTURE_PROPOSAL,
    });
    // status stays 'proposed'.
    const { instanceId: builderInstanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "builder",
      instanceName: "builder-1",
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(BUILDER_DEFINITION);
    const adapter = new InMemoryAutomationAdapter();
    const router = makeRouter(
      fakeProvider({ version: "v1", build: {} }),
      fixture.db,
    );

    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId: builderInstanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runBuilder(ctx, {
          db: fixture.db as unknown as Parameters<typeof runBuilder>[1]["db"],
          automationAdapter: adapter,
          candidateId,
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
    expect(rows.rows[0]?.output?.name).toBe("BuilderGate2Error");
    // No deployment was ever attempted.
    expect(adapter.deployments).toHaveLength(0);
  });
});

describe("runBuilder — Gate 3 (deploys, never activates)", () => {
  it("happy path: requireApproved → deploy → INSERT deployment row at status='deployed' → markBuilt", async () => {
    const fixture = await freshAgentDb();
    const { candidateId, builderInstanceId } = await seedApprovedCandidate(fixture);
    const definitions = new AgentDefinitionRegistry();
    definitions.register(BUILDER_DEFINITION);
    const adapter = new InMemoryAutomationAdapter();
    const llmPayload: BuilderOutput = {
      version: "v1",
      build: {
        candidate_id: candidateId,
        template_slug: "weekly-ping",
        resolved_params: { day: "Friday" },
        skills_used: [],
      },
    };
    const router = makeRouter(fakeProvider(llmPayload), fixture.db);

    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId: builderInstanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runBuilder(ctx, {
          db: fixture.db as unknown as Parameters<typeof runBuilder>[1]["db"],
          automationAdapter: adapter,
          candidateId,
        }),
    });

    expect(result.status).toBe("success");

    // AutomationAdapter received exactly one deploy call.
    expect(adapter.deployments).toHaveLength(1);
    expect(adapter.deployments[0]?.templateSlug).toBe("weekly-ping");

    // automation_deployments row at status='deployed'
    // (Gate 3 — never 'activated' from this code path).
    const deployRows = await fixture.raw.query<{
      status: string;
      n8n_workflow_id: string;
      candidate_id: string;
    }>(
      `SELECT status::text AS status, n8n_workflow_id, candidate_id::text AS candidate_id
       FROM automation_deployments`,
    );
    expect(deployRows.rows).toHaveLength(1);
    expect(deployRows.rows[0]?.status).toBe("deployed");
    expect(deployRows.rows[0]?.candidate_id).toBe(candidateId);
    expect(deployRows.rows[0]?.n8n_workflow_id).toMatch(/^n8n-wf-/);

    // Candidate flipped approved → built.
    const candidateRows = await fixture.raw.query<{ status: string }>(
      `SELECT status::text AS status FROM automation_candidates WHERE id = $1::uuid`,
      [candidateId],
    );
    expect(candidateRows.rows[0]?.status).toBe("built");
  });

  it("refuses LLM-mismatched candidate_id (hallucination guard)", async () => {
    const fixture = await freshAgentDb();
    const { candidateId, builderInstanceId } = await seedApprovedCandidate(fixture);
    const definitions = new AgentDefinitionRegistry();
    definitions.register(BUILDER_DEFINITION);
    const adapter = new InMemoryAutomationAdapter();
    const llmPayload: BuilderOutput = {
      version: "v1",
      build: {
        // LLM returned a DIFFERENT candidate_id — refuse.
        candidate_id: "00000000-0000-0000-0000-000000000099",
        template_slug: "weekly-ping",
        resolved_params: { day: "Friday" },
        skills_used: [],
      },
    };
    const router = makeRouter(fakeProvider(llmPayload), fixture.db);

    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId: builderInstanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runBuilder(ctx, {
          db: fixture.db as unknown as Parameters<typeof runBuilder>[1]["db"],
          automationAdapter: adapter,
          candidateId,
        }),
    });

    expect(result.status).toBe("failed");
    // No deploy attempted.
    expect(adapter.deployments).toHaveLength(0);
    // Candidate stays at 'approved' — markBuilt was never called.
    const rows = await fixture.raw.query<{ status: string }>(
      `SELECT status::text AS status FROM automation_candidates WHERE id = $1::uuid`,
      [candidateId],
    );
    expect(rows.rows[0]?.status).toBe("approved");
  });

  it("refuses LLM-mismatched template_slug (hallucination guard)", async () => {
    const fixture = await freshAgentDb();
    const { candidateId, builderInstanceId } = await seedApprovedCandidate(fixture);
    const definitions = new AgentDefinitionRegistry();
    definitions.register(BUILDER_DEFINITION);
    const adapter = new InMemoryAutomationAdapter();
    const llmPayload: BuilderOutput = {
      version: "v1",
      build: {
        candidate_id: candidateId,
        template_slug: "different-template", // mismatch
        resolved_params: {},
        skills_used: [],
      },
    };
    const router = makeRouter(fakeProvider(llmPayload), fixture.db);

    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId: builderInstanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runBuilder(ctx, {
          db: fixture.db as unknown as Parameters<typeof runBuilder>[1]["db"],
          automationAdapter: adapter,
          candidateId,
        }),
    });
    expect(result.status).toBe("failed");
    expect(adapter.deployments).toHaveLength(0);
  });
});
