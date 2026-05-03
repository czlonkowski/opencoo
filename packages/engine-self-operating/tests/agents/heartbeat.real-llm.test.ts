/**
 * heartbeat.real-llm.test.ts (PR-N3, phase-a appendix #6)
 *
 * Real-LLM smoke for the Heartbeat agent. Boots the in-memory
 * MCP fixture seeded with one fake worldview + one wiki page,
 * constructs a production `LlmRouter` against OpenRouter, and
 * invokes `runHeartbeat` via `invokeAgent`. Asserts the
 * produced JSON conforms to the Heartbeat output schema and
 * carries the expected shape (summary present, alerts ≤ 5,
 * priority-1 first when alerts exist).
 *
 * Gated on `RUN_REAL_LLM=1`. Requires:
 *   - `OPENROUTER_API_KEY` in env (or repo-root .env)
 *   - `OPENROUTER_DEFAULT_MODEL` (defaults to `moonshotai/kimi-k2.6`)
 *
 * Budget: under $1 per run against the OpenRouter test key.
 *
 * Usage:
 *   RUN_REAL_LLM=1 pnpm --filter @opencoo/engine-self-operating \
 *     test heartbeat.real-llm
 */
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");

// Load .env from repo root (non-throwing — CI may not have the file).
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
  HEARTBEAT_DEFINITION,
  HEARTBEAT_OUTPUT_SCHEMA,
  runHeartbeat,
  type HeartbeatOutput,
} from "../../src/agents/heartbeat/index.js";

import {
  freshAgentDb,
  seedAgentInstance,
} from "../agent-harness/_pglite-fixture.js";

const RUN_REAL_LLM = process.env["RUN_REAL_LLM"] === "1";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const FIXTURE_WORLDVIEW = `# Worldview — test domain

The team is shipping the Q3 strategic deck this Friday for the
Sales department.  Onboarding is on hold pending the deck.  No
risk register entries are open.
`;

const FIXTURE_PAGE = `---
title: "Q3 strategic deck"
type: project
tags: [strategy, sales, q3]
last_updated: "2026-04-30T10:00:00Z"
---

## Status

Drafting in progress.  Sales is blocked on the final draft.

## Risks

None tracked.
`;

describe.skipIf(!RUN_REAL_LLM)(
  "runHeartbeat — real-LLM (RUN_REAL_LLM=1)",
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

      // Pin the test-domain's llm_policy to OpenRouter.
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
      "produces a schema-valid HeartbeatOutput against the fixture wiki",
      async () => {
        const { instanceId } = await seedAgentInstance(fixture, {
          definitionSlug: "heartbeat",
          memory: { type: "none" },
        });

        const mcp = new InMemoryMcpToolClient();
        mcp.setResource("wiki://test-domain/projects/q3.md", FIXTURE_PAGE);
        mcp.setResource("worldview://test-domain", FIXTURE_WORLDVIEW);

        const definitions = new AgentDefinitionRegistry();
        definitions.register(HEARTBEAT_DEFINITION);

        const result = await invokeAgent({
          definitions,
          db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
          router,
          logger: silentLogger(),
          instanceId,
          trigger: "scheduled",
          inputs: {},
          run: (ctx) =>
            runHeartbeat(ctx, {
              db: fixture.db as unknown as Parameters<typeof runHeartbeat>[1]["db"],
              mcp,
              domainSlug: "test-domain",
            }),
        });

        expect(result.status).toBe("success");
        // Re-validate the persisted output against the schema —
        // the harness already parsed via router.generateObject,
        // but the stricter parse here pins the contract again.
        const output = HEARTBEAT_OUTPUT_SCHEMA.parse(result.output);
        const typed = output as HeartbeatOutput;
        expect(typed.version).toBe("v1");
        expect(typeof typed.summary).toBe("string");
        expect(typed.summary.length).toBeGreaterThan(0);
        expect(typed.alerts.length).toBeLessThanOrEqual(5);
        if (typed.alerts.length > 0) {
          expect(typed.alerts[0]?.priority).toBe(1);
          for (const alert of typed.alerts) {
            expect(alert.citations.length).toBeGreaterThan(0);
          }
        }
      },
      180_000,
    );
  },
);
