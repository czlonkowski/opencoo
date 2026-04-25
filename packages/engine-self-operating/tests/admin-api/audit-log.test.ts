/**
 * Audit-log writer tests (PR 28 / plan #128, THREAT-MODEL §3.13).
 *
 * The writer is the single sanctioned path to `admin_audit_log`
 * (the `opencoo/no-update-append-only` ESLint rule pins the
 * append-only invariant). Tests:
 *   - Action-allowlist Zod-validation rejects unknown verbs.
 *   - userId Zod-validation rejects malformed input.
 *   - User-Agent truncation at 256 bytes.
 *   - Insert returns the row id.
 *   - Read endpoint paginates correctly.
 *   - Read endpoint self-records as `audit_log.read`.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  AUDIT_LOG_ACTIONS,
  writeAuditLog,
} from "../../src/admin-api/audit-log.js";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

async function seedUser(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  username: string,
): Promise<string> {
  const result = await raw.query<{ id: string }>(
    `INSERT INTO users (gitea_username, role) VALUES ($1, 'operator') RETURNING id`,
    [username],
  );
  return result.rows[0]!.id;
}

describe("admin-api audit-log — writeAuditLog", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("inserts one row and returns the id", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    const userId = await seedUser(f.raw, "alice");
    const result = await writeAuditLog(
      f.db as unknown as Parameters<typeof writeAuditLog>[0],
      {
        action: "automation_candidate.approve",
        userId,
        metadata: { candidate_id: "cid" },
      },
    );
    expect(typeof result.id).toBe("string");
    const rows = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log WHERE id = $1::uuid`,
      [result.id],
    );
    expect(rows.rows[0]?.action).toBe("automation_candidate.approve");
  });

  it("rejects an action verb not in AUDIT_LOG_ACTIONS (Zod allowlist)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    const userId = await seedUser(f.raw, "alice");
    await expect(
      writeAuditLog(
        f.db as unknown as Parameters<typeof writeAuditLog>[0],
        {
          // @ts-expect-error — the test asserts runtime rejection.
          action: "bogus.unknown",
          userId,
          metadata: {},
        },
      ),
    ).rejects.toThrow();
  });

  it("rejects malformed userId (Zod uuid validation)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    await expect(
      writeAuditLog(
        f.db as unknown as Parameters<typeof writeAuditLog>[0],
        {
          action: "automation_candidate.approve",
          userId: "not-a-uuid",
          metadata: {},
        },
      ),
    ).rejects.toThrow();
  });

  it("truncates User-Agent to 256 bytes", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    const userId = await seedUser(f.raw, "alice");
    const longUa = "x".repeat(1024);
    await writeAuditLog(
      f.db as unknown as Parameters<typeof writeAuditLog>[0],
      {
        action: "automation_candidate.approve",
        userId,
        metadata: {},
        userAgent: longUa,
      },
    );
    const rows = await f.raw.query<{ user_agent: string | null }>(
      `SELECT user_agent FROM admin_audit_log WHERE user_id = $1::uuid`,
      [userId],
    );
    expect(rows.rows[0]?.user_agent?.length).toBe(256);
  });

  it("AUDIT_LOG_ACTIONS contains all the planner-named verbs", () => {
    // Defensive — if a future PR drops a verb, this list test
    // signals at the point of the change rather than at runtime
    // when a route can't write.
    expect(AUDIT_LOG_ACTIONS).toContain("automation_candidate.approve");
    expect(AUDIT_LOG_ACTIONS).toContain("automation_candidate.reject");
    expect(AUDIT_LOG_ACTIONS).toContain("marketplace_update.accept");
    expect(AUDIT_LOG_ACTIONS).toContain("marketplace_update.skip");
    expect(AUDIT_LOG_ACTIONS).toContain("audit_log.read");
  });
});

describe("admin-api audit-log — GET /api/admin/audit-log", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns recent rows + self-records the read", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    f.gitea.responses.set("admin-pat", {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    // Seed a single audit row.
    const userId = await seedUser(f.raw, "alice");
    await writeAuditLog(
      f.db as unknown as Parameters<typeof writeAuditLog>[0],
      {
        action: "automation_candidate.approve",
        userId,
        metadata: { candidate_id: "cid" },
      },
    );
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/audit-log?limit=10&offset=0",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{ action: string }>;
    };
    expect(body.rows.length).toBeGreaterThanOrEqual(1);
    expect(body.rows.some((r) => r.action === "automation_candidate.approve")).toBe(
      true,
    );

    // Self-recording: the read should have written an
    // `audit_log.read` row.
    const readRows = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log WHERE action = 'audit_log.read'`,
    );
    expect(readRows.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("paginates via ?limit + ?offset", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    f.gitea.responses.set("admin-pat", {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const userId = await seedUser(f.raw, "alice");
    for (let i = 0; i < 5; i++) {
      await writeAuditLog(
        f.db as unknown as Parameters<typeof writeAuditLog>[0],
        {
          action: "automation_candidate.approve",
          userId,
          metadata: { candidate_id: `cid-${i}` },
        },
      );
    }
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/audit-log?limit=2&offset=0",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[] };
    expect(body.rows).toHaveLength(2);
  });

  it("rejects ?limit > 100", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    f.gitea.responses.set("admin-pat", {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/audit-log?limit=999",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(400);
  });

  // Reference getCsrf so the import isn't tree-shaken; the
  // CSRF handshake isn't required for the GET /audit-log route
  // (it's read-only) but the import keeps the test file ready
  // for a future endpoint addition.
  void getCsrf;
});
