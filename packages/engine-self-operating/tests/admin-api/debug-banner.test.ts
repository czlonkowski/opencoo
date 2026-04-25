/**
 * Debug-banner onSend hook tests (PR 28 / plan #128).
 *
 * When `LLM_DEBUG_LOG=1`, every JSON response from the admin
 * API carries `_llmDebugLogActive: true`. The Management UI
 * renders a persistent banner so the operator never misses
 * that LLM prompts + responses are mirrored to
 * `llm_usage_debug` (and that audit retention applies).
 *
 * Off by default — registering the hook with `llmDebugLog:
 * false` means non-banner responses go through unchanged.
 */
import { afterEach, describe, expect, it } from "vitest";

import { DEBUG_BANNER_FIELD } from "../../src/admin-api/debug-banner.js";

import { makeAdminFixture } from "./_fixture.js";

describe("admin-api debug-banner — LLM_DEBUG_LOG=1 banner injection", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("does NOT inject the banner when llmDebugLog is false (default)", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: false,
    });
    cleanup = f.close;
    f.gitea.responses.set("admin-pat", {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(DEBUG_BANNER_FIELD in body).toBe(false);
  });

  it("injects `_llmDebugLogActive: true` into JSON bodies when llmDebugLog is true", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: true,
    });
    cleanup = f.close;
    f.gitea.responses.set("admin-pat", {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body[DEBUG_BANNER_FIELD]).toBe(true);
    // The original field is still there.
    expect(typeof body["csrfToken"]).toBe("string");
  });

  it("injects the banner on error responses too (401 etc.)", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: true,
    });
    cleanup = f.close;
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      // No auth → 401 JSON body should also carry the banner.
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body[DEBUG_BANNER_FIELD]).toBe(true);
  });

  it("DEBUG_BANNER_FIELD is the literal '_llmDebugLogActive'", () => {
    expect(DEBUG_BANNER_FIELD).toBe("_llmDebugLogActive");
  });
});
