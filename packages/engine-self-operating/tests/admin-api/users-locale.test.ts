/**
 * `PATCH /api/admin/users/me/locale` (PR-C2, phase-a appendix #16
 * wave-16).
 *
 * Operator-controlled per-account locale preference, persisted on
 * `users.locale_preference`. Two-tier persistence: localStorage is
 * the in-session SoT on the client, this row is the DB SoT at
 * login (the SPA reads it back via `/_csrf` hydration).
 *
 * Pin matrix:
 *   1. 401 without admin auth (missing Authorization header).
 *   2. 422 for invalid locale (Zod boundary rejects {'fr', '', null,
 *      arbitrary strings}).
 *   3. 200 for valid PATCH; `users.locale_preference` updated;
 *      audit row written BEFORE the UPDATE (audit-write-before-
 *      mutate invariant, THREAT-MODEL §3.5).
 *   4. Audit verb is exactly `user.set_locale_preference`; metadata
 *      records `user_id`, `new_locale`, `caller_username`.
 *   5. 403 without CSRF token (state-changing route).
 *   6. `/api/admin/_csrf` hydration returns the persisted
 *      `locale_preference` so the SPA can sync localStorage at
 *      login.
 *
 * Mirrors the W5 source-binding set_notes/set_retention_override
 * pattern: SELECT-prev → write-audit → UPDATE. Even on a no-op
 * (resending the same value) the audit row is still emitted so
 * the trail records operator intent.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-c2-locale";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

describe("PATCH /api/admin/users/me/locale (PR-C2)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("401 without admin auth (missing Authorization header)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;

    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/users/me/locale",
      headers: { "content-type": "application/json" },
      payload: { locale: "pl" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 without CSRF token even with valid admin PAT", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    // Establish the session via _csrf so the user row exists,
    // then PATCH without the CSRF header/cookie.
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/users/me/locale",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
      },
      payload: { locale: "pl" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("422 for invalid locale (Zod rejects 'fr', empty, garbage)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    for (const bogus of ["fr", "", "EN", "polski", "en-US"]) {
      const res = await f.app.inject({
        method: "PATCH",
        url: "/api/admin/users/me/locale",
        headers: {
          authorization: `Bearer ${ADMIN_PAT}`,
          "x-csrf-token": csrfToken,
          cookie: `opencoo_csrf=${cookie}`,
          "content-type": "application/json",
        },
        payload: { locale: bogus },
      });
      expect(res.statusCode).toBe(422);
    }
  });

  it("422 for missing locale field", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/users/me/locale",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("200 — valid PATCH updates locale_preference + writes audit row BEFORE the UPDATE", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    // Pre-flight: audit log must be empty before the PATCH so we
    // can pin "the audit row written here, not earlier".
    const auditBefore = await f.raw.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM admin_audit_log
        WHERE action = 'user.set_locale_preference'`,
    );
    expect(auditBefore.rows[0]?.n).toBe("0");

    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/users/me/locale",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { locale: "pl" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      localePreference: string;
    };
    expect(body.ok).toBe(true);
    expect(body.localePreference).toBe("pl");

    // Row persisted + capture the user UUID so the audit
    // assertion below pins `metadata.user_id` to the actual
    // operator row, not to itself (Copilot review #166).
    const row = await f.raw.query<{
      id: string;
      locale_preference: string | null;
      gitea_username: string;
    }>(
      `SELECT id::text AS id, locale_preference, gitea_username FROM users
        WHERE gitea_username = 'alice'`,
    );
    expect(row.rows[0]?.locale_preference).toBe("pl");
    const aliceId = row.rows[0]!.id;
    expect(aliceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Audit row written with the exact verb + canonical metadata
    // shape. Body bytes never enter the audit table (no operator-
    // freeform input — locale is constrained to {'en','pl'} by
    // both Zod and DB CHECK).
    const audit = await f.raw.query<{
      action: string;
      metadata: {
        user_id: string;
        new_locale: string;
        caller_username: string;
      };
    }>(
      `SELECT action, metadata FROM admin_audit_log
        WHERE action = 'user.set_locale_preference'
        ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.action).toBe("user.set_locale_preference");
    expect(audit.rows[0]?.metadata.new_locale).toBe("pl");
    expect(audit.rows[0]?.metadata.caller_username).toBe("alice");
    // Pin `user_id` to the actual operator UUID — the route is
    // self-only so the audit user_id MUST equal the verified
    // adminContext.userId. Selecting `id` from users beats
    // comparing the metadata field to itself.
    expect(audit.rows[0]?.metadata.user_id).toBe(aliceId);
  });

  it("200 — clearing to 'en' overwrites a previously-set 'pl'", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    // First PATCH: pl.
    await f.app.inject({
      method: "PATCH",
      url: "/api/admin/users/me/locale",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { locale: "pl" },
    });

    // Second PATCH: en. A fresh CSRF roundtrip mirrors the SPA's
    // per-PATCH issuance pattern (the existing W5 tests do this
    // for each state-changing request).
    const { csrfToken: c2, cookie: ck2 } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/users/me/locale",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": c2,
        cookie: `opencoo_csrf=${ck2}`,
        "content-type": "application/json",
      },
      payload: { locale: "en" },
    });
    expect(res.statusCode).toBe(200);

    const row = await f.raw.query<{ locale_preference: string | null }>(
      `SELECT locale_preference FROM users WHERE gitea_username = 'alice'`,
    );
    expect(row.rows[0]?.locale_preference).toBe("en");

    // Two audit rows now exist — one per PATCH.
    const auditCount = await f.raw.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM admin_audit_log
        WHERE action = 'user.set_locale_preference'`,
    );
    expect(auditCount.rows[0]?.n).toBe("2");
  });
});

describe("/api/admin/_csrf hydrates localePreference (PR-C2)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns localePreference=null on first sign-in (no preference set)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      csrfToken: string;
      username: string | null;
      localePreference: string | null;
    };
    expect(body.username).toBe("alice");
    expect(body.localePreference).toBeNull();
  });

  it("returns the persisted localePreference after PATCH", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    await f.app.inject({
      method: "PATCH",
      url: "/api/admin/users/me/locale",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { locale: "pl" },
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      csrfToken: string;
      username: string | null;
      localePreference: string | null;
    };
    expect(body.localePreference).toBe("pl");
  });
});
