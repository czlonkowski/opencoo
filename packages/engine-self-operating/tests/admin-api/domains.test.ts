/**
 * Domains list + prompts manifest + logout tests (PR 29 /
 * plan #131). The LLM-policy preview/apply tests live in their
 * own file because the surface is bigger.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set("admin-pat", {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

describe("admin-api domains route (PR 29)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("GET /api/admin/domains returns rows shaped for the UI", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await f.raw.exec(`
      INSERT INTO domains (slug, name, locale, llm_policy)
      VALUES ('exec', 'Executive', 'en', '{"thinker":{"provider":"anthropic"}}'::jsonb);
    `);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/domains",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{
        slug: string;
        llmPolicy: Record<string, unknown>;
        isAggregator: boolean;
      }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.slug).toBe("exec");
    expect(body.rows[0]?.llmPolicy).toEqual({
      thinker: { provider: "anthropic" },
    });
    expect(body.rows[0]?.isAggregator).toBe(false);
  });
});

describe("admin-api prompts route (PR 29)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("GET /api/admin/prompts returns one entry per prompt name with locale + version", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/prompts",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      entries: Array<{
        name: string;
        locales: Array<{ locale: string; version: string }>;
      }>;
    };
    expect(body.entries.length).toBeGreaterThan(0);
    // Every entry has at least one (locale, version) pair.
    for (const e of body.entries) {
      expect(e.locales.length).toBeGreaterThan(0);
      for (const l of e.locales) {
        expect(typeof l.locale).toBe("string");
        expect(l.locale).not.toBe("auto"); // auto is resolved at call time
        expect(/^\d+\.\d+\.\d+$/.test(l.version)).toBe(true);
      }
    }
  });
});

describe("admin-api logout route (PR 29)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("POST /api/admin/logout clears cookies + writes a session.logout audit row", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/logout",
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie)
      ? setCookie.join(", ")
      : setCookie ?? "";
    expect(cookieStr).toContain("opencoo_session=;");
    expect(cookieStr).toContain("opencoo_csrf=;");
    expect(cookieStr).toContain("Max-Age=0");

    const auditRows = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log WHERE action = 'session.logout'`,
    );
    expect(auditRows.rows.length).toBe(1);
  });

  it("POST /api/admin/logout requires CSRF (no token → 403)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/logout",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(403);
  });
});
