/**
 * `GET /api/admin/agent-runs/:id` — single run with tool-call timeline.
 *
 * Test-first artifact for PR-B (phase-a appendix #4).
 *
 * Pin matrix:
 *   1. Returns 404 for unknown run id.
 *   2. Returns the full run row including `toolCalls`, `skillsUsed`.
 *   3. `LLM_DEBUG_LOG` gate: `output` field is redacted (null) unless
 *      `LLM_DEBUG_LOG=1` env is set — THREAT-MODEL §2 invariant 11.
 *   4. When `LLM_DEBUG_LOG=1`, `output` is included.
 *   5. Requires admin auth.
 *   6. (I1) Returns 400 for a malformed (non-UUID) :id param.
 *   7. (I2) `inputs` gated behind LLM_DEBUG_LOG the same as `output`.
 */
import { afterEach, describe, expect, it } from "vitest";

import { makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "agent-runs-detail-pat";

describe("admin-api GET /api/admin/agent-runs/:id — detail", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns 401 without admin auth", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/agent-runs/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for unknown run id", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/agent-runs/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns run detail including toolCalls and skillsUsed", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const toolCalls = JSON.stringify([
      { name: "wiki_read", input: { path: "index.md" }, output: "...", startedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    const skillsUsed = JSON.stringify([
      { slug: "heartbeat-base", version: "1.0.0", sha: "abc123", source: "builtin" },
    ]);
    const insertResult = await f.raw.query<{ id: string }>(
      `INSERT INTO agent_runs
         (definition_slug, trigger, status, tool_calls, skills_used,
          tokens_in, tokens_out, cost_usd, latency_ms, output)
       VALUES ('heartbeat', 'scheduled', 'success', $1::jsonb, $2::jsonb,
               100, 200, '0.001234', 1500, '{"summary": "all good"}'::jsonb)
       RETURNING id::text AS id`,
      [toolCalls, skillsUsed],
    );
    const id = insertResult.rows[0]!.id;

    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/agent-runs/${id}`,
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["id"]).toBe(id);
    expect(body["definitionSlug"]).toBe("heartbeat");
    expect(body["status"]).toBe("success");
    expect(Array.isArray(body["toolCalls"])).toBe(true);
    expect(Array.isArray(body["skillsUsed"])).toBe(true);
    expect(typeof body["tokensIn"]).toBe("number");
    expect(typeof body["costUsd"]).toBe("string");
  });

  it("gates output behind LLM_DEBUG_LOG — omits output when gate is off", async () => {
    const f = await makeAdminFixture({ llmDebugLog: false });
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const insertResult = await f.raw.query<{ id: string }>(
      `INSERT INTO agent_runs
         (definition_slug, trigger, status, output)
       VALUES ('heartbeat', 'scheduled', 'success', '{"raw_prompt": "system: you are..."}'::jsonb)
       RETURNING id::text AS id`,
    );
    const id = insertResult.rows[0]!.id;

    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/agent-runs/${id}`,
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    // output must be null when LLM_DEBUG_LOG is off
    expect(body["output"]).toBeNull();
  });

  it("includes output when LLM_DEBUG_LOG=1", async () => {
    const f = await makeAdminFixture({ llmDebugLog: true });
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const insertResult = await f.raw.query<{ id: string }>(
      `INSERT INTO agent_runs
         (definition_slug, trigger, status, output)
       VALUES ('heartbeat', 'scheduled', 'success', '{"summary": "all good"}'::jsonb)
       RETURNING id::text AS id`,
    );
    const id = insertResult.rows[0]!.id;

    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/agent-runs/${id}`,
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    // output is included when debug gate is on
    expect(body["output"]).not.toBeNull();
    expect(body["output"]).toMatchObject({ summary: "all good" });
  });

  // ── I1: UUID validation ────────────────────────────────────────────────────

  it("returns 400 for a malformed (non-UUID) :id param", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/agent-runs/not-a-uuid",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["error"]).toBe("invalid_id");
  });

  it("accepts a valid UUID :id param (even if not found)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    // Use a properly-formatted UUID v4 — Zod 4's z.string().uuid() validates
    // the version nibble (must be 1-5) and variant bits.
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/agent-runs/00000000-0000-4000-8000-000000000001",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    // Valid UUID but no matching row → 404, not 400.
    expect(res.statusCode).toBe(404);
  });

  // ── I2: inputs gating ─────────────────────────────────────────────────────

  it("gates inputs behind LLM_DEBUG_LOG — omits inputs when gate is off", async () => {
    const f = await makeAdminFixture({ llmDebugLog: false });
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const insertResult = await f.raw.query<{ id: string }>(
      `INSERT INTO agent_runs
         (definition_slug, trigger, status, inputs)
       VALUES ('heartbeat', 'scheduled', 'success', '{"since": "2026-04-01"}'::jsonb)
       RETURNING id::text AS id`,
    );
    const id = insertResult.rows[0]!.id;

    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/agent-runs/${id}`,
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    // inputs is null when LLM_DEBUG_LOG is off (may contain PII).
    expect(body["inputs"]).toBeNull();
  });

  it("includes inputs when LLM_DEBUG_LOG=1", async () => {
    const f = await makeAdminFixture({ llmDebugLog: true });
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const insertResult = await f.raw.query<{ id: string }>(
      `INSERT INTO agent_runs
         (definition_slug, trigger, status, inputs)
       VALUES ('heartbeat', 'scheduled', 'success', '{"since": "2026-04-01"}'::jsonb)
       RETURNING id::text AS id`,
    );
    const id = insertResult.rows[0]!.id;

    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/agent-runs/${id}`,
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    // inputs is returned when debug gate is on
    expect(body["inputs"]).not.toBeNull();
    expect(body["inputs"]).toMatchObject({ since: "2026-04-01" });
  });
});
