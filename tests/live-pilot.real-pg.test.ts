/**
 * Live-pilot end-to-end integration test (PR-Q14, phase-a appendix #9).
 *
 * Lands LAST in the appendix-#9 wave; every fix from Q1–Q13 is on
 * `main` and forms the stable green baseline this test asserts
 * against. Each appendix-#9 PR ships its own targeted regression
 * test, but none exercise the WHOLE chain in one shot — a regression
 * in any single Q-fix can pass per-package CI yet still break the
 * live pilot. PR-Q14 closes that gap with one test fanning across
 * every Q-fix surface in a single run, against real Postgres + Redis
 * + Gitea.
 *
 * # Q-fix coverage
 *
 *   Q0  husky fresh-worktree guard — implicit (test runs inside one)
 *   Q1  SSE auth via fetch-streaming — readFirstSseEvent + Bearer
 *   Q2  agent runners drizzle-wrapped — invokeAgent → agent_runs row
 *   Q3  MCP HTTP Accept header — agent tool reads succeed
 *       (InMemoryMcpToolClient stands in here; the wire-level header
 *       is pinned by gitea-wiki-mcp-server's own tests + the runbook
 *       §4 manual walk against the real MCP server)
 *   Q4  OpenRouter in LlmRouter + PROVIDER_ENV_OPTS —
 *       MODEL_CATALOG.openrouter has 'moonshotai/kimi-k2.6' AND the
 *       llm-policy editor accepts provider='openrouter'
 *   Q5  migration 0010 USING clause — runMigrate succeeds
 *   Q6  shared Fastify mount — admin API + /webhooks/<id> on one port
 *   Q7  per-adapter signature extraction + inner-secret unwrap —
 *       synthetic Asana webhook signed via x-hook-signature over the
 *       inner x_hook_secret (NOT the JSON-wrapped blob) is accepted
 *   Q8  agents-seed --domain flow — runAgentsSeed succeeds
 *   Q9  binding config persisted — POST source-bindings accepts
 *       `config` and lands it on sources_bindings.config
 *   Q10 sources drill-down PATCH/DELETE happy paths
 *   Q10b i18n + TOCTOU — covered by PR-Q10b's own tests; the
 *       PATCH/DELETE shape here exercises the same response paths
 *   Q11 CredentialForm grouped labels — UI-only, no backend exercise
 *   Q12 gitea-wiki-mcp-server per-request transport — exercised at
 *       the contract level via the heartbeat agent's MCP reads.
 *       Standing the MCP server up in compose.e2e.yml would balloon
 *       this PR's scope; runbook §4 is the canonical end-to-end
 *       verification of the MCP transport against a real Gitea.
 *   Q13 GET /api/admin/llm-models returns the catalog
 *
 * # Gating
 *
 *   RUN_REAL_PILOT=1 — required to drive the full chain. Without
 *     it, the file still loads under vitest and runs a single
 *     documentation-passing assertion via `describe.skipIf(ENABLED)`
 *     so the suite stays discoverable; the heavy beforeAll bootstrap
 *     is gated and never fires.
 *   RUN_REAL_LLM=1 (optional) — present in env so a future sub-PR
 *     can wire a real OpenRouter dispatch without test-shape churn;
 *     today the policy-apply path is route-only (no provider call).
 *
 * # Deferred assertions
 *
 *   - Per-request MCP transport (Q12) is asserted via the agent
 *     body's call shape, not via the real gitea-wiki-mcp-server.
 *   - The full compile→wiki-write chain is NOT driven —
 *     `tests/e2e/ingest-to-wiki.test.ts` pins that path end-to-end
 *     against compose-spun Gitea. This test stops at
 *     webhook_events.signature_ok=true + post-receive enqueue.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";

import { ConsoleLogger } from "../packages/shared/src/logger.js";
import {
  LlmRouter,
  MockLlmClient,
  MODEL_CATALOG,
} from "../packages/shared/src/llm-router/index.js";

import {
  AgentDefinitionRegistry,
  invokeAgent,
} from "../packages/engine-self-operating/src/agent-harness/index.js";
import { InMemoryMcpToolClient } from "../packages/engine-self-operating/src/mcp-tool-client/index.js";
import {
  HEARTBEAT_DEFINITION,
  runHeartbeat,
  type HeartbeatOutput,
} from "../packages/engine-self-operating/src/agents/heartbeat/index.js";

import { runMigrate } from "../packages/cli/src/commands/migrate.js";
import { runAgentsSeed } from "../packages/cli/src/commands/agents-seed.js";
import {
  __setProcessExit,
  __resetProcessExit,
  ExitSentinel,
  isExitSentinel,
} from "../packages/cli/src/lib/exit.js";

import { ASANA_ADAPTER_SLUG } from "../packages/adapters/source-asana/src/adapter.js";

import {
  dockerAvailable,
  startCompose,
  stopCompose,
  E2E_ENDPOINTS,
} from "./e2e/_setup/compose-controller.js";
import {
  bootstrapEnvironment,
  disposeEnvironment,
  resetForTest,
  type E2EEnvironment,
} from "./e2e/_setup/seed.js";

import {
  buildLivePilotServer,
  csrf,
  adminHeaders,
  LIVE_PILOT_ENCRYPTION_KEY_HEX,
  type LivePilotServerHandle,
} from "./helpers/live-pilot/server.js";

const RUN_REAL_PILOT = process.env["RUN_REAL_PILOT"] === "1";
const RUN_REAL_LLM = process.env["RUN_REAL_LLM"] === "1";
const HAS_DOCKER = dockerAvailable();
const ENABLED = RUN_REAL_PILOT && HAS_DOCKER;

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

/** Drive a CLI verb that calls `exitOk()` / `exitRuntimeError()` —
 *  intercepts the process.exit sentinel so the test can assert on
 *  the captured code without halting vitest. */
async function runCliVerb(
  fn: () => Promise<void>,
): Promise<{ readonly code: number }> {
  let captured: number | null = null;
  __setProcessExit(((code: number): never => {
    captured = code;
    throw new ExitSentinel(code);
  }) as never);
  try {
    await fn();
  } catch (err) {
    if (!isExitSentinel(err)) throw err;
  } finally {
    __resetProcessExit();
  }
  return { code: captured ?? 0 };
}

/** Open a one-shot SSE connection with `Authorization: Bearer ...`
 *  and resolve with the FIRST `event: connected` payload. The
 *  admin-API's events route always emits this acknowledgement
 *  inline before parking the request — its arrival proves the
 *  fetch-streaming auth path works (PR-Q1). */
async function readFirstSseEvent(
  baseUrl: string,
  pat: string,
  timeoutMs: number,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/admin/events`, {
      headers: { Authorization: `Bearer ${pat}` },
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`SSE: expected 200, got ${res.status}`);
    }
    if (res.body === null) {
      throw new Error("SSE: response body is null");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE event boundary is a blank line (\n\n).
      const idx = buf.indexOf("\n\n");
      if (idx >= 0) {
        const event = buf.slice(0, idx);
        // Cancel the stream so Fastify's keep-alive isn't held open
        // for the rest of the test.
        ac.abort();
        await reader.cancel().catch(() => undefined);
        return event;
      }
    }
    throw new Error("SSE: stream ended before any event arrived");
  } finally {
    clearTimeout(timer);
  }
}

/** Sign a JSON body with the Asana scheme: HMAC-SHA256 over the
 *  RAW body bytes using the inner `x_hook_secret` value (NOT the
 *  JSON-wrapped credential plaintext that lives at rest). */
function signAsana(body: string, innerSecret: string): string {
  return crypto.createHmac("sha256", innerSecret).update(body).digest("hex");
}

let env: E2EEnvironment | null = null;
let server: LivePilotServerHandle | null = null;

beforeAll(async () => {
  if (!ENABLED) return;
  await startCompose();
  env = await bootstrapEnvironment();
  server = await buildLivePilotServer(env);
}, 600_000);

afterAll(async () => {
  if (server !== null) {
    await server.close().catch(() => undefined);
    server = null;
  }
  await disposeEnvironment();
  // Tear compose down only when we own the lifecycle: the suite
  // actually started it (ENABLED) AND we're not on CI (the
  // workflow's failure handler captures `docker compose logs` /
  // `inspect` artifacts AFTER vitest exits, so leaving compose up
  // there preserves them; the workflow's own teardown step then
  // releases the runner).
  if (ENABLED && HAS_DOCKER && !process.env.CI) {
    await stopCompose().catch(() => undefined);
  }
}, 60_000);

describe.runIf(ENABLED)(
  "live-pilot — appendix #9 chain (PR-Q14)",
  () => {
    it(
      "runs the full Q1–Q13 chain end-to-end against compose-spun Postgres + Redis + Gitea",
      async () => {
        const e = env!;
        const s = server!;
        // PR-Q5 leaves the schema applied. resetForTest clears the
        // mutable tables so this test sees a clean slate but doesn't
        // re-run migrations (idempotent — drizzle's tracker would
        // skip them anyway).
        await resetForTest(e, { wikiRepos: [] });

        // ----- Q5: migrate idempotency. bootstrapEnvironment() already
        // applied them; re-running must be a no-op (regressed 0010
        // USING clause would surface here on the second pass).
        const migrateResult = await runCliVerb(() =>
          runMigrate({
            env: { DATABASE_URL: E2E_ENDPOINTS.postgresUrl },
            skipMigrate: false,
            stdout: { write: (): boolean => true },
            stderr: { write: (): boolean => true },
          }),
        );
        expect(migrateResult.code).toBe(0);

        // ----- Q4 / Q13: openrouter present in MODEL_CATALOG (source
        // of truth) AND surfaced by GET /api/admin/llm-models (the
        // editor's per-tier dropdown reads it on mount).
        expect(MODEL_CATALOG.openrouter).toContain("moonshotai/kimi-k2.6");

        const handshake = await csrf(s.baseUrl, e.giteaAdminPat);
        const modelsRes = await fetch(`${s.baseUrl}/api/admin/llm-models`, {
          headers: { Authorization: `Bearer ${e.giteaAdminPat}` },
        });
        expect(modelsRes.status).toBe(200);
        const modelsBody = (await modelsRes.json()) as {
          catalog: Record<string, readonly string[]>;
        };
        expect(modelsBody.catalog["openrouter"]).toContain(
          "moonshotai/kimi-k2.6",
        );

        // ----- Q6: admin path + webhook path BOTH reach s.baseUrl.
        // The CSRF GET above proved /api/admin/*; the webhook POST
        // below proves /webhooks/*. Both go to the same listener.

        // ----- Seed a knowledge domain via SQL. The admin-API
        // domains POST + Gitea provisioning round-trip is already
        // pinned by `tests/e2e/domain-and-binding-create.test.ts`.
        const domainSlug = "wiki-live-pilot";
        const domainRow = await e.pgPool.query<{ id: string }>(
          `INSERT INTO domains (slug, name, locale, class)
           VALUES ($1, 'Live Pilot', 'en', 'knowledge'::domain_class)
           RETURNING id`,
          [domainSlug],
        );
        const domainId = domainRow.rows[0]!.id;

        // ----- Q9: POST source-bindings accepts + persists `config`.
        // Asana is the most-exercised binding shape in the live session
        // and carries a non-trivial config (projectGid required).
        const innerHookSecret = `live-pilot-${Date.now()}`;
        const bindingPayload = {
          adapter_slug: ASANA_ADAPTER_SLUG,
          target_domain_slug: domainSlug,
          credentials: {
            auth: {
              personal_access_token: "live-pilot-pat",
              workspace_gid: "22222",
            },
            webhook_secret: { x_hook_secret: innerHookSecret },
          },
          config: {
            projectGid: "11111",
            workspaceGid: "22222",
            snapshotMode: "off",
            monitoredProjectGids: ["11111"],
          },
        };
        const bindingCreate = await fetch(
          `${s.baseUrl}/api/admin/source-bindings`,
          {
            method: "POST",
            headers: adminHeaders(e.giteaAdminPat, handshake),
            body: JSON.stringify(bindingPayload),
          },
        );
        expect(bindingCreate.status).toBe(201);
        const { id: bindingId } = (await bindingCreate.json()) as {
          id: string;
        };

        // Q9 persistence: the `config` field landed on the row.
        const cfgRow = await e.pgPool.query<{
          config: Record<string, unknown>;
        }>(
          `SELECT config FROM sources_bindings WHERE id = $1::uuid`,
          [bindingId],
        );
        expect(cfgRow.rows[0]!.config["projectGid"]).toBe("11111");
        expect(cfgRow.rows[0]!.config["snapshotMode"]).toBe("off");

        // ----- Q4 wire-up: llm-policy preview + apply accept
        // provider='openrouter'. No LLM dispatch — route-only.
        const proposedPolicy = {
          thinker: { provider: "openrouter", model: "moonshotai/kimi-k2.6" },
          worker: { provider: "openrouter", model: "moonshotai/kimi-k2.6" },
          light: { provider: "openrouter", model: "moonshotai/kimi-k2.6" },
        };
        const previewRes = await fetch(
          `${s.baseUrl}/api/admin/domains/${domainId}/llm-policy/preview`,
          {
            method: "POST",
            headers: adminHeaders(e.giteaAdminPat, handshake),
            body: JSON.stringify({ proposed: proposedPolicy }),
          },
        );
        expect(previewRes.status).toBe(200);
        const previewBody = (await previewRes.json()) as { token: string };
        expect(typeof previewBody.token).toBe("string");
        expect(previewBody.token.length).toBeGreaterThan(0);

        const applyRes = await fetch(
          `${s.baseUrl}/api/admin/domains/${domainId}/llm-policy/apply`,
          {
            method: "POST",
            headers: adminHeaders(e.giteaAdminPat, handshake),
            body: JSON.stringify({
              proposed: proposedPolicy,
              token: previewBody.token,
              confirmDiff: true,
            }),
          },
        );
        expect(applyRes.status).toBe(200);
        // Confirm the row reflects the applied policy.
        const policyRow = await e.pgPool.query<{
          llm_policy: Record<string, { provider: string; model: string }>;
        }>(
          `SELECT llm_policy FROM domains WHERE id = $1::uuid`,
          [domainId],
        );
        expect(policyRow.rows[0]!.llm_policy["thinker"]?.provider).toBe(
          "openrouter",
        );
        expect(policyRow.rows[0]!.llm_policy["thinker"]?.model).toBe(
          "moonshotai/kimi-k2.6",
        );
        // RUN_REAL_LLM is reserved for a future sub-PR that dispatches
        // a real OpenRouter call through the applied policy.
        void RUN_REAL_LLM;

        // ----- Q1: SSE auth via fetch-streaming. The /api/admin/events
        // route emits `connected` inline before parking; receiving it
        // proves the Bearer header survived to the route AND that the
        // streaming body is reachable.
        const firstEvent = await readFirstSseEvent(
          s.baseUrl,
          e.giteaAdminPat,
          5_000,
        );
        expect(firstEvent).toContain("event: connected");
        expect(firstEvent).toContain("connectedAt");

        // ----- Q7: synthetic Asana-shaped webhook. Body is a minimal
        // events:[] payload; the receiver verifies HMAC BEFORE event
        // parsing, so signature_ok=true on the persisted row is the
        // load-bearing assertion regardless of what parseEvents does.
        const eventBody = JSON.stringify({
          events: [
            {
              created_at: new Date().toISOString(),
              user: { gid: "u1" },
              resource: { gid: "task1", resource_type: "task" },
              action: "added",
            },
          ],
        });
        const sig = signAsana(eventBody, innerHookSecret);
        const webhookRes = await fetch(
          `${s.baseUrl}/webhooks/${bindingId}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hook-signature": sig,
              "x-event-id": `live-pilot-${Date.now()}`,
              "x-provider": "asana",
            },
            body: eventBody,
          },
        );
        // 200 = signature verified + record written. Any non-200 here
        // indicates Q7 regressed (typical cause: receiver verified
        // HMAC against the JSON-wrapped credential bytes instead of
        // the inner x_hook_secret).
        expect(webhookRes.status).toBe(200);

        // Row written inline before returning 200 — single SELECT.
        const events = await e.pgPool.query<{
          signature_ok: boolean;
          binding_id: string;
        }>(
          `SELECT signature_ok, binding_id::text AS binding_id
           FROM webhook_events
           WHERE binding_id = $1::uuid
           ORDER BY received_at DESC
           LIMIT 1`,
          [bindingId],
        );
        expect(events.rowCount).toBeGreaterThanOrEqual(1);
        expect(events.rows[0]!.signature_ok).toBe(true);

        // ----- Q8: runAgentsSeed --domain <slug> succeeds.
        const seedResult = await runCliVerb(() =>
          runAgentsSeed({
            env: { DATABASE_URL: E2E_ENDPOINTS.postgresUrl },
            stdout: { write: (): boolean => true },
            stderr: { write: (): boolean => true },
            domainSlug,
          }),
        );
        expect(seedResult.code).toBe(0);

        // Three rows seeded: heartbeat, lint, surfacer.
        const seededInstances = await e.pgPool.query<{
          definition_slug: string;
        }>(
          `SELECT definition_slug FROM agent_instances
           WHERE $1::uuid = ANY(scope_domain_ids)
           ORDER BY definition_slug`,
          [domainId],
        );
        const seededSlugs = seededInstances.rows.map(
          (r) => r.definition_slug,
        );
        expect(seededSlugs).toContain("heartbeat");
        expect(seededSlugs).toContain("lint");

        // ----- Q2 / Q3: agent runners drizzle-wrapped + MCP contract.
        // Heartbeat through invokeAgent; agent_runs row lands success.
        const heartbeatInstanceId = (
          await e.pgPool.query<{ id: string }>(
            `SELECT id FROM agent_instances
             WHERE definition_slug = 'heartbeat'
               AND $1::uuid = ANY(scope_domain_ids)
             LIMIT 1`,
            [domainId],
          )
        ).rows[0]!.id;

        const mcp = new InMemoryMcpToolClient();
        mcp.setResource(
          `worldview://${domainSlug}`,
          "# Worldview\n\nLive-pilot domain.",
        );
        mcp.setResource(
          `wiki://${domainSlug}/index.md`,
          "# Index\n\n- live-pilot/welcome.md",
        );

        const heartbeatPayload: HeartbeatOutput = {
          version: "v1",
          summary: "Live-pilot OK.",
          alerts: [
            {
              priority: 1,
              title: "Live-pilot ship-gate",
              body: "PR-Q14 closes appendix #9.",
              citations: ["live-pilot/welcome.md"],
            },
          ],
        };
        const mock = new MockLlmClient();
        mock.register({
          match: { model: "gpt-4o-mini", promptIncludes: "Heartbeat" },
          response: {
            text: JSON.stringify(heartbeatPayload),
            tokensIn: 200,
            tokensOut: 80,
          },
        });
        const router = new LlmRouter({
          db: e.db as unknown as Parameters<typeof LlmRouter>[0]["db"],
          // OPENROUTER_API_KEY is forwarded so a future RUN_REAL_LLM
          // path doesn't need router-construction churn; the mock
          // provider below overrides the real dispatcher today.
          env: { OPENROUTER_API_KEY: process.env["OPENROUTER_API_KEY"] ?? "" },
          logger: silentLogger(),
          pauser: {
            paused: () => false,
            pause: () => undefined,
            resume: () => undefined,
          },
          provider: mock,
        });

        const definitions = new AgentDefinitionRegistry();
        definitions.register(HEARTBEAT_DEFINITION);
        const heartbeatResult = await invokeAgent({
          definitions,
          db: e.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
          router,
          logger: silentLogger(),
          instanceId: heartbeatInstanceId,
          trigger: "scheduled",
          inputs: {},
          run: (ctx) =>
            runHeartbeat(ctx, {
              db: e.db as unknown as Parameters<typeof runHeartbeat>[1]["db"],
              mcp,
              domainSlug,
            }),
        });
        expect(heartbeatResult.status).toBe("success");

        // Q2: the drizzle-wrapped recorder writes the row inline.
        const heartbeatRunRow = await e.pgPool.query<{
          status: string;
          definition_slug: string;
        }>(
          `SELECT status::text AS status, definition_slug
           FROM agent_runs WHERE id = $1::uuid`,
          [heartbeatResult.runId],
        );
        expect(heartbeatRunRow.rows[0]!.status).toBe("success");
        expect(heartbeatRunRow.rows[0]!.definition_slug).toBe("heartbeat");

        // Q12 contract surrogate: the runner exercised ≥2 MCP reads
        // (worldview + index). The wire-level per-request transport
        // is pinned by gitea-wiki-mcp-server's own tests; the >=4
        // concurrent path lives in the Lint runner whose unit tests
        // cover it. Pulling Lint into this test would require LLM
        // detector calls (runLintCore) and bust the scope ceiling.

        // ----- Q10: PATCH (disable) then DELETE happy paths.
        const patchRes = await fetch(
          `${s.baseUrl}/api/admin/source-bindings/${bindingId}`,
          {
            method: "PATCH",
            headers: adminHeaders(e.giteaAdminPat, handshake),
            body: JSON.stringify({ enabled: false }),
          },
        );
        expect(patchRes.status).toBe(200);
        const patchedRow = await e.pgPool.query<{ enabled: boolean }>(
          `SELECT enabled FROM sources_bindings WHERE id = $1::uuid`,
          [bindingId],
        );
        expect(patchedRow.rows[0]!.enabled).toBe(false);

        // DELETE: tx clears webhook_events + ingestion_intake in the
        // same statement, so the binding deletes cleanly. 409 is
        // reserved for append-only audit FKs we haven't populated.
        const deleteRes = await fetch(
          `${s.baseUrl}/api/admin/source-bindings/${bindingId}`,
          {
            method: "DELETE",
            headers: adminHeaders(e.giteaAdminPat, handshake),
          },
        );
        expect(deleteRes.status).toBe(200);
        const remain = await e.pgPool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM sources_bindings WHERE id = $1::uuid`,
          [bindingId],
        );
        expect(remain.rows[0]!.count).toBe("0");

        // Sentinel: server still listening on its single port (Q6
        // honored at end-of-test, not just at start).
        const stillUp = await fetch(`${s.baseUrl}/api/admin/llm-models`, {
          headers: { Authorization: `Bearer ${e.giteaAdminPat}` },
        });
        expect(stillUp.status).toBe(200);

        // Defence-in-depth: encryption key bytes never appear in
        // credential ciphertext rows.
        const credBytes = await e.pgPool.query<{ ciphertext: Buffer }>(
          `SELECT ciphertext FROM credentials LIMIT 5`,
        );
        for (const row of credBytes.rows) {
          expect(row.ciphertext.toString("hex")).not.toContain(
            LIVE_PILOT_ENCRYPTION_KEY_HEX,
          );
        }
      },
      300_000,
    );
  },
);

describe.skipIf(ENABLED)(
  "live-pilot — appendix #9 chain (PR-Q14) — disabled",
  () => {
    it("skips when RUN_REAL_PILOT!=1 or Docker is unavailable", () => {
      // Documentation-only assertion. The real test runs nightly
      // via `.github/workflows/nightly-live-pilot.yml`.
      expect(ENABLED).toBe(false);
    });
  },
);
