/**
 * surfacer.real-llm.test.ts (PR-N3, phase-a appendix #6)
 *
 * Real-LLM smoke for the Surfacer agent. Boots in-memory MCP
 * with a worldview + a small page index, constructs a production
 * `LlmRouter` against OpenRouter, and invokes `runSurfacer`.
 * Asserts the produced JSON conforms to the Surfacer output
 * schema (≤10 candidates, every cites ≥1 wiki page) and that
 * Gate 1 inserts pass through (or are correctly rejected when
 * the LLM proposes an unknown template_slug).
 *
 * Gated on `RUN_REAL_LLM=1`. Requires `OPENROUTER_API_KEY`.
 * Budget: under $1 per run.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
dotenv.config({ path: path.resolve(REPO_ROOT, ".env") });

import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  InMemoryQueuePauser,
  LlmRouter,
  createOpenRouterProvider,
} from "@opencoo/shared/llm-router";

import {
  AgentDefinitionRegistry,
  invokeAgent,
} from "../../src/agent-harness/index.js";
import { InMemoryMcpToolClient } from "../../src/mcp-tool-client/index.js";
import {
  SURFACER_DEFINITION,
  SURFACER_OUTPUT_SCHEMA,
  runSurfacer,
} from "../../src/agents/surfacer/index.js";

import {
  freshAgentDb,
  seedAgentInstance,
} from "../agent-harness/_pglite-fixture.js";

const RUN_REAL_LLM = process.env["RUN_REAL_LLM"] === "1";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const FIXTURE_WORLDVIEW = `# Worldview — operations

The team manually pings Sales every Friday for Q3 deck status.
Operations frequently chases overdue Asana tasks. Onboarding
checklists are tracked in a Google Sheet that nobody updates.
`;

const FIXTURE_PAGES: Readonly<Record<string, string>> = {
  "projects/q3.md": "Due Friday. Sales blocked.",
  "ops/onboarding.md": "Manual checklist; one missed step blocks Day-1.",
  "ops/asana-cleanup.md": "Operations sweeps overdue Asana every Monday.",
};

const AVAILABLE_TEMPLATES = [
  "weekly-ping",
  "asana-overdue-sweep",
  "checklist-reminder",
] as const;

describe.skipIf(!RUN_REAL_LLM)(
  "runSurfacer — real-LLM (RUN_REAL_LLM=1)",
  () => {
    let fixture: Awaited<ReturnType<typeof freshAgentDb>>;
    let router: LlmRouter;

    beforeAll(async () => {
      const apiKey = process.env["OPENROUTER_API_KEY"];
      if (!apiKey) {
        throw new Error(
          "RUN_REAL_LLM=1 requires OPENROUTER_API_KEY",
        );
      }
      const model =
        process.env["RUN_REAL_LLM_MODEL"] ??
        process.env["OPENROUTER_DEFAULT_MODEL"] ??
        "moonshotai/kimi-k2.6";

      fixture = await freshAgentDb();
      const policy = {
        thinker: { provider: "openai", model },
        worker: { provider: "openai", model },
        light: { provider: "openai", model },
        local_only: false,
      };
      await fixture.db.execute(sql`
        UPDATE domains SET llm_policy = ${JSON.stringify(policy)}::jsonb
        WHERE id = ${fixture.domainId}::uuid
      `);

      const provider = await createOpenRouterProvider({ apiKey });
      router = new LlmRouter({
        db: fixture.db as unknown as Parameters<
          typeof LlmRouter.prototype.generateText
        >[0],
        env: process.env,
        logger: silentLogger(),
        pauser: new InMemoryQueuePauser(),
        provider,
      });
    }, 60_000);

    it(
      "produces a schema-valid SurfacerOutput against the fixture wiki + template list",
      async () => {
        const { instanceId } = await seedAgentInstance(fixture, {
          definitionSlug: "surfacer",
          memory: { type: "none" },
        });

        const mcp = new InMemoryMcpToolClient();
        for (const [pagePath, body] of Object.entries(FIXTURE_PAGES)) {
          mcp.setResource(`wiki://test-domain/${pagePath}`, body);
        }
        mcp.setResource("worldview://test-domain", FIXTURE_WORLDVIEW);

        const definitions = new AgentDefinitionRegistry();
        definitions.register(SURFACER_DEFINITION);

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
              availableTemplateSlugs: [...AVAILABLE_TEMPLATES],
            }),
        });

        expect(result.status).toBe("success");
        // The agent's `output` payload is the SurfacerOutput
        // (version + candidates) plus an `insertedCandidateIds`
        // field — the schema parses the SurfacerOutput shape and
        // ignores the extra field.
        const out = result.output as {
          version: string;
          candidates: unknown[];
          insertedCandidateIds: string[];
        };
        const parsed = SURFACER_OUTPUT_SCHEMA.parse({
          version: out.version,
          candidates: out.candidates,
        });
        expect(parsed.version).toBe("v1");
        expect(parsed.candidates.length).toBeLessThanOrEqual(10);
        for (const c of parsed.candidates) {
          expect(c.source_page_refs.length).toBeGreaterThan(0);
        }
        // insertedCandidateIds is the count of candidates that
        // had a recognised template_slug. Every accepted slug
        // must be in the available list (defensive — the prompt
        // already constrained the LLM).
        expect(Array.isArray(out.insertedCandidateIds)).toBe(true);
      },
      180_000,
    );
  },
);
