/**
 * `POST /api/admin/domains` — domain create (phase-a appendix #2).
 *
 * Closes PRD §5 #1 ("default domain without manual DB edits").
 * The route INSERTs a `domains` row inside a transaction and
 * calls `provisionDomainRepo` to seed the Gitea repo. Failure
 * of provisioning rolls back the DB transaction (fail-closed)
 * so an operator never sees a domain row with no Gitea repo.
 *
 * Pin matrix (9 assertions):
 *   1. 200 happy: row + repoUrl + audit
 *   2. 409 slug_taken on duplicate slug
 *   3. 422 invalid slug (regex)
 *   4. 401 without Authorization header
 *   5. 403 without CSRF
 *   6. audit-log row present after success
 *   7. provisionDomainRepo called once with correct args (slug,
 *      class, locale, operator PAT)
 *   8. rollback on Gitea provisioning failure (no row + no audit)
 *   9. error response never echoes credential/secret bytes
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-domain-create";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

describe("admin-api POST /api/admin/domains (phase-a appendix #2)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("201 happy: inserts domains row + provisions repo + writes audit", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        slug: "wiki-main",
        class: "knowledge",
        display_name: "Main wiki",
        default_locale: "en",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      id: string;
      slug: string;
      repoUrl: string;
    };
    expect(body.slug).toBe("wiki-main");
    expect(body.repoUrl).toMatch(/wiki-main$/);

    // The domain was inserted.
    const rows = await f.raw.query<{ slug: string; class: string }>(
      `SELECT slug, class::text AS class FROM domains WHERE slug = $1`,
      ["wiki-main"],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.class).toBe("knowledge");

    // Audit-log row written.
    const audit = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log WHERE action = 'domain.create'`,
    );
    expect(audit.rows).toHaveLength(1);

    // Provisioner called exactly once with the right args.
    expect(f.provisioner.calls).toHaveLength(1);
    expect(f.provisioner.calls[0]).toMatchObject({
      slug: "wiki-main",
      domainClass: "knowledge",
      defaultLocale: "en",
      pat: ADMIN_PAT,
    });
  });

  it("409 slug_taken on duplicate slug", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await f.raw.exec(
      `INSERT INTO domains (slug, name, locale) VALUES ('exec', 'Exec', 'en');`,
    );
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        slug: "exec",
        class: "knowledge",
        display_name: "Exec",
        default_locale: "en",
      },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("slug_taken");

    // Provisioner NEVER called on slug-collision (DB-level guard
    // fires before any Gitea round-trip).
    expect(f.provisioner.calls).toHaveLength(0);
  });

  it("422 on invalid slug (regex must match domains_slug_format)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        slug: "Bad Slug With Spaces",
        class: "knowledge",
        display_name: "Bad",
        default_locale: "en",
      },
    });
    expect(res.statusCode).toBe(422);
    expect(f.provisioner.calls).toHaveLength(0);
  });

  it("401 without Authorization header", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains",
      payload: {
        slug: "wiki-main",
        class: "knowledge",
        display_name: "Main",
        default_locale: "en",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 without CSRF", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
      payload: {
        slug: "wiki-main",
        class: "knowledge",
        display_name: "Main",
        default_locale: "en",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rollback on Gitea provisioning failure: no domain row + no audit", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    f.provisioner.nextError = new Error("gitea provisioning failed");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        slug: "wiki-rollback",
        class: "knowledge",
        display_name: "Rollback",
        default_locale: "en",
      },
    });
    // 5xx — provisioning failure surfaces as a typed error.
    expect(res.statusCode).toBeGreaterThanOrEqual(500);

    // No domain row.
    const rows = await f.raw.query<{ slug: string }>(
      `SELECT slug FROM domains WHERE slug = 'wiki-rollback'`,
    );
    expect(rows.rows).toHaveLength(0);

    // No audit row for this slug.
    const audit = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'domain.create'`,
    );
    expect(audit.rows).toHaveLength(0);
  });

  it("response body NEVER echoes the operator PAT bytes (credential isolation)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    f.provisioner.nextError = new Error(
      `gitea upstream said: token ${ADMIN_PAT} is invalid`,
    );
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        slug: "wiki-leak",
        class: "knowledge",
        display_name: "leak",
        default_locale: "en",
      },
    });
    // Whatever status: the body must NOT contain the PAT.
    expect(res.body).not.toContain(ADMIN_PAT);
  });

  it("audit-log metadata captures slug + class + provisioned repo url + caller username", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    f.provisioner.nextRepoUrl = "https://gitea.test/opencoo/wiki-meta";
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    await f.app.inject({
      method: "POST",
      url: "/api/admin/domains",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        slug: "wiki-meta",
        class: "knowledge",
        display_name: "Meta",
        default_locale: "en",
      },
    });
    const audit = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'domain.create'`,
    );
    expect(audit.rows).toHaveLength(1);
    const meta = audit.rows[0]!.metadata;
    expect(meta).toMatchObject({
      slug: "wiki-meta",
      class: "knowledge",
      repo_url: "https://gitea.test/opencoo/wiki-meta",
      caller_username: "alice",
    });
    // PAT bytes never recorded in metadata.
    expect(JSON.stringify(meta)).not.toContain(ADMIN_PAT);
  });

  it("422 when class is not in the enum (rejects 'invalid-class')", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/domains",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        slug: "wiki-x",
        class: "invalid-class",
        display_name: "x",
        default_locale: "en",
      },
    });
    expect(res.statusCode).toBe(422);
  });
});
