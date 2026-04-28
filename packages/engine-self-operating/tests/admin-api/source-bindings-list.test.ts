/**
 * `GET /api/admin/source-bindings` — list all bindings (phase-a
 * fixup).
 *
 * Closes a UX gap surfaced by smoke-testing PR #37: the Sources
 * tab in the Management UI showed "No bindings yet" even after
 * the operator successfully created `auto`-mode + enabled drive
 * bindings, because the list endpoint's SQL was filtering to
 * `WHERE review_mode = 'review' OR enabled = false`. Architecture
 * §13 says the Sources tab is "list + add" of every binding, not
 * a needs-attention queue (that's the Review Dashboard's job per
 * §7.3). Drop the filter so all bindings show up.
 *
 * Pin matrix (3 assertions):
 *   1. auto-mode + enabled binding IS in the response (regression
 *      for the actual UX bug); the assertion also checks that the
 *      response carries `reviewMode` + `enabled` fields the UI
 *      needs for columns / status badges.
 *   2. review-mode binding IS in the response (no regression on
 *      the prior "needs attention" rows)
 *   3. disabled binding IS in the response
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-binding-list";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

async function seedDomain(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  slug: string,
): Promise<{ readonly id: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name, locale, class) VALUES ($1, 'Test', 'en', 'knowledge') RETURNING id`,
    [slug],
  );
  return { id: r.rows[0]!.id };
}

async function seedBinding(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  domainId: string,
  adapterSlug: string,
  reviewMode: "auto" | "approve" | "review",
  enabled: boolean,
): Promise<{ readonly id: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled)
     VALUES ($1::uuid, $2, $3::review_mode, $4) RETURNING id::text AS id`,
    [domainId, adapterSlug, reviewMode, enabled],
  );
  return { id: r.rows[0]!.id };
}

describe("admin-api GET /api/admin/source-bindings — list all bindings", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns auto-mode + enabled bindings (the UX-bug regression test)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-auto");
    const bnd = await seedBinding(f.raw, dom.id, "drive", "auto", true);

    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/source-bindings",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{ id: string; reviewMode: string; enabled: boolean }>;
    };
    const ids = body.rows.map((b) => b.id);
    expect(ids).toContain(bnd.id);
    const found = body.rows.find((b) => b.id === bnd.id)!;
    expect(found.reviewMode).toBe("auto");
    expect(found.enabled).toBe(true);
  });

  it("returns review-mode bindings (no regression on prior needs-attention rows)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-review");
    const bnd = await seedBinding(f.raw, dom.id, "fireflies", "review", true);

    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/source-bindings",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{ id: string; reviewMode: string }>;
    };
    expect(body.rows.map((b) => b.id)).toContain(bnd.id);
    expect(body.rows.find((b) => b.id === bnd.id)!.reviewMode).toBe("review");
  });

  it("returns disabled bindings", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-disabled");
    const bnd = await seedBinding(f.raw, dom.id, "drive", "auto", false);

    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/source-bindings",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{ id: string; enabled: boolean }>;
    };
    expect(body.rows.map((b) => b.id)).toContain(bnd.id);
    expect(body.rows.find((b) => b.id === bnd.id)!.enabled).toBe(false);
  });
});
