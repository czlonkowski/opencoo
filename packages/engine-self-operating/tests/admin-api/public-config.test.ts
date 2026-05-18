/**
 * /api/public/config — unauthenticated config endpoint (PR-W18,
 * phase-a appendix #18).
 *
 * Surfaces the operator-facing Gitea URL so the PAT-entry modal can
 * render a clickable "Open Gitea" link with on-screen instructions
 * for generating a token. Gitea is the human-review surface for
 * compiled wikis (architecture §10), so production deployments
 * SHOULD set GITEA_PUBLIC_URL — but the endpoint stays callable when
 * it's unset, returning `{ giteaUrl: null }` so the SPA falls back
 * to "explanation only, no link".
 *
 * Threat-model contract:
 *   - Unauthenticated — no auth header, no CSRF cookie required.
 *   - Returns ONLY the env-derived URL; no PII, no credentials, no
 *     operator-freeform text.
 *   - Static read — no body, no params, no audit row.
 */
import { afterEach, describe, expect, it } from "vitest";

import { makeAdminFixture } from "./_fixture.js";

describe("/api/public/config (PR-W18)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) await cleanup();
    cleanup = null;
  });

  it("200 — returns null giteaUrl when GITEA_PUBLIC_URL is unset", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    const res = await f.app.inject({
      method: "GET",
      url: "/api/public/config",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ giteaUrl: null });
  });

  it("200 — returns the configured Gitea URL when set", async () => {
    const f = await makeAdminFixture({
      giteaPublicUrl: "https://gitea.example.com/",
    });
    cleanup = f.close;
    const res = await f.app.inject({
      method: "GET",
      url: "/api/public/config",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ giteaUrl: "https://gitea.example.com/" });
  });

  it("does NOT require authentication", async () => {
    // No Authorization header. Without the public-config wiring this
    // would 401 via the admin-API gate, OR 404 if the route never
    // registered. Either failure mode is a regression.
    const f = await makeAdminFixture({
      giteaPublicUrl: "https://gitea.example.com/",
    });
    cleanup = f.close;
    const res = await f.app.inject({
      method: "GET",
      url: "/api/public/config",
      // No headers — explicitly anonymous.
    });
    expect(res.statusCode).toBe(200);
  });

  it("does NOT leak any non-config fields", async () => {
    // Pin the payload shape so future maintainers don't accidentally
    // widen this surface to expose PII, version strings, or admin
    // team membership in the same response (THREAT-MODEL §3.13).
    const f = await makeAdminFixture({
      giteaPublicUrl: "https://gitea.example.com/",
    });
    cleanup = f.close;
    const res = await f.app.inject({
      method: "GET",
      url: "/api/public/config",
    });
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["giteaUrl"]);
  });
});
