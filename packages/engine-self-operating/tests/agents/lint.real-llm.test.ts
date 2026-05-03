/**
 * lint.real-llm.test.ts (PR-N3, phase-a appendix #6)
 *
 * Real-LLM smoke for the Lint agent. Seeds 5–10 wiki pages so
 * `WIKI_READ_PAGE_CONCURRENCY=4` is exercised (the contradictions
 * detector samples up to CONTRADICTIONS_PAGE_CAP and reads them
 * in concurrent batches), constructs a production `LlmRouter`
 * against OpenRouter, and invokes `runLint` via `invokeAgent`.
 * Asserts the produced JSON conforms to the Lint output schema
 * and that findings have the expected union shape.
 *
 * Gated on `RUN_REAL_LLM=1`. Requires:
 *   - `OPENROUTER_API_KEY` in env (or repo-root .env)
 *
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
  LINT_DEFINITION,
  LINT_OUTPUT_SCHEMA,
  runLint,
  type LintOutput,
} from "../../src/agents/lint/index.js";

import {
  freshAgentDb,
  seedAgentInstance,
  seedBinding,
  seedPageCitation,
} from "../agent-harness/_pglite-fixture.js";

const RUN_REAL_LLM = process.env["RUN_REAL_LLM"] === "1";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const PAGES = [
  ["team/eng.md", "## Stack\n\nPython 3.11. CI runs on GitHub Actions."],
  ["team/data.md", "## Stack\n\nPython 3.10. CI runs on Jenkins."],
  ["projects/q3.md", "Due Friday. Sales blocked."],
  ["projects/q4.md", "Planning starts Monday."],
  ["projects/onboarding.md", "Pending Q3 deck."],
  ["docs/style.md", "Use 2-space indentation."],
  ["docs/api.md", "REST endpoints under /v1."],
] as const;

describe.skipIf(!RUN_REAL_LLM)(
  "runLint — real-LLM (RUN_REAL_LLM=1)",
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
      "produces a schema-valid LintOutput across 7 wiki pages (concurrency batched)",
      async () => {
        // Seed bindings + citations so the orphan / stale-pages
        // / prompt-drift detectors all have inputs to work with.
        const narrow = await seedBinding(fixture, {
          adapterSlug: "asana",
          allowedPaths: PAGES.map(([p]) => p),
        });
        for (const [pagePath] of PAGES) {
          await seedPageCitation(fixture, {
            pagePath,
            bindingId: narrow.bindingId,
            promptVersion: "1.0.0",
          });
        }

        // Seed MCP with the page bodies.
        const mcp = new InMemoryMcpToolClient();
        for (const [pagePath, body] of PAGES) {
          mcp.setResource(`wiki://test-domain/${pagePath}`, body);
        }
        mcp.setResource(
          "worldview://test-domain",
          "# Worldview — test\n\nEngineering team primary stack: Python.",
        );

        const { instanceId } = await seedAgentInstance(fixture, {
          definitionSlug: "lint",
          memory: { type: "none" },
        });
        const definitions = new AgentDefinitionRegistry();
        definitions.register(LINT_DEFINITION);

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
              definitions,
            }),
        });

        expect(result.status).toBe("success");
        const output = LINT_OUTPUT_SCHEMA.parse(result.output) as LintOutput;
        expect(output.version).toBe("v1");
        expect(Array.isArray(output.findings)).toBe(true);
        // Every finding carries a recognised `kind`.
        const recognisedKinds = new Set([
          "wildcard_bindings",
          "stale_pages",
          "orphans",
          "prompt_version_drift",
          "contradictions",
          "automation_drift",
        ]);
        for (const f of output.findings) {
          expect(recognisedKinds.has(f.kind)).toBe(true);
        }
      },
      180_000,
    );
  },
);
