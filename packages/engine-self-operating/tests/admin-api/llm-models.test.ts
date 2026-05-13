/**
 * `GET /api/admin/llm-models` — model catalog endpoint
 * (PR-Q13, phase-a appendix #9).
 *
 * Read-only; the LLM-policy editor's per-tier model dropdown
 * loads its options from this response. Server-side single
 * source of truth so v0.2's dynamic-fetch lift slots into
 * the same endpoint without UI churn.
 *
 * Pins:
 *  - Returns the static catalog from shared verbatim.
 *  - verifyAdmin gate (401 without PAT, 403 for outsider).
 *  - No CSRF — read-only GET.
 */
import { afterEach, describe, expect, it } from "vitest";

import { MODEL_CATALOG } from "@opencoo/shared/llm-router";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set("admin-pat", {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

describe("admin-api llm-models route (PR-Q13)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns the static catalog keyed by provider", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/llm-models",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      catalog: Record<string, readonly string[]>;
    };
    expect(body.catalog).toEqual(MODEL_CATALOG);
  });

  it("includes the openrouter seed (moonshotai/kimi-k2.6)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/llm-models",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      catalog: Record<string, readonly string[]>;
    };
    expect(body.catalog["openrouter"]).toContain("moonshotai/kimi-k2.6");
  });

  it("ollama arm is empty (operator pastes a custom model)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/llm-models",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      catalog: Record<string, readonly string[]>;
    };
    expect(body.catalog["ollama"]).toEqual([]);
  });

  it("requires verifyAdmin (401 without Authorization header)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/llm-models",
    });
    expect(res.statusCode).toBe(401);
  });

  it("requires admin team membership (403 for outsider)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    f.gitea.responses.set("outsider-pat", {
      username: "eve",
      teams: ["other-team"],
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/llm-models",
      headers: { authorization: "Bearer outsider-pat" },
    });
    expect(res.statusCode).toBe(403);
  });

  // Sanity — endpoint stays reachable after the SPA's CSRF round-trip.
  it("works after the CSRF round-trip the SPA performs at boot", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/llm-models",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
  });
});
