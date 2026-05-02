/**
 * `GET /api/admin/source-bindings` — 3-state status enrichment
 * (phase-a appendix #4 PR-A).
 *
 * Tests the new fields added by this PR:
 *   - `name`         — human-readable label (notes or adapter→domain)
 *   - `status`       — 'healthy' | 'advisory' | 'alert' | null
 *   - `lastEventAt`  — ISO string of most-recent webhook_events.received_at
 *   - `lastError`    — truncated + scrubbed ingestion_intake.error_class
 *
 * 3-state computation rules (verbatim from appendix):
 *   alert    if: latest ingestion_intake.error_class non-null in last 24h,
 *               OR sig-fail count in last 24h ≥ 1,
 *               OR DLQ depth > 0.
 *   advisory if: no events in last 7d (looks idle),
 *               OR latest webhook_events.received_at older than 24h on an
 *               enabled binding.
 *   healthy  if: events arriving normally with no failures.
 *   null     if: lastEventAt IS NULL with enabled=true (newly-created,
 *               never fired — render neutral, not alert).
 *   null     if: enabled=false (paused — neutral regardless).
 *
 * Additional invariant (THREAT-MODEL §3.6 invariant 11):
 *   last_error is scrubbed — no PAT bytes in the response.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-status-test";

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

/** Seed a source binding. `notes` is optional and, when set, becomes
 *  the human-readable `name` in the response. */
async function seedBinding(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  domainId: string,
  adapterSlug: string,
  opts: {
    readonly enabled?: boolean;
    readonly notes?: string;
  } = {},
): Promise<{ readonly id: string }> {
  const enabled = opts.enabled ?? true;
  const r = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled, notes)
     VALUES ($1::uuid, $2, 'auto'::review_mode, $3, $4) RETURNING id::text AS id`,
    [domainId, adapterSlug, enabled, opts.notes ?? null],
  );
  return { id: r.rows[0]!.id };
}

// Note: webhook_events + ingestion_intake tables are now part of the
// base fixture DDL in _fixture.ts — no per-test table creation needed.

/** Seed a webhook event for a binding with configurable age + sig_ok. */
async function seedWebhookEvent(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  bindingId: string,
  opts: {
    readonly signatureOk?: boolean;
    readonly ageHours?: number;
  } = {},
): Promise<void> {
  const ageHours = opts.ageHours ?? 0;
  const signatureOk = opts.signatureOk ?? true;
  await raw.query(
    `INSERT INTO webhook_events (provider, payload_hash, signature_ok, binding_id, received_at)
     VALUES ('test', 'hash', $1, $2::uuid, NOW() - ($3 || ' hours')::interval)`,
    [signatureOk, bindingId, String(ageHours)],
  );
}

/** Seed an ingestion_intake row with an optional error_class. */
async function seedIntakeRow(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  bindingId: string,
  opts: {
    readonly errorClass?: string | null;
    readonly ageHours?: number;
  } = {},
): Promise<void> {
  const ageHours = opts.ageHours ?? 0;
  const docId = `doc-${Date.now()}-${Math.random()}`;
  await raw.query(
    `INSERT INTO ingestion_intake
       (binding_id, source_doc_id, source_revision, content_hash, status, error_class, created_at)
     VALUES ($1::uuid, $2, 'rev1', 'ch1', 'failed', $3, NOW() - ($4 || ' hours')::interval)`,
    [bindingId, docId, opts.errorClass ?? null, String(ageHours)],
  );
}

async function getBindings(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
  pat: string,
): Promise<{
  rows: Array<{
    id: string;
    name: string;
    status: string | null;
    lastEventAt: string | null;
    lastError: string | null;
    enabled: boolean;
  }>;
}> {
  const { csrfToken, cookie } = await getCsrf(fixture, pat);
  const res = await fixture.app.inject({
    method: "GET",
    url: "/api/admin/source-bindings",
    headers: {
      authorization: `Bearer ${pat}`,
      "x-csrf-token": csrfToken,
      cookie: `opencoo_csrf=${cookie}`,
    },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as {
    rows: Array<{
      id: string;
      name: string;
      status: string | null;
      lastEventAt: string | null;
      lastError: string | null;
      enabled: boolean;
    }>;
  };
}

// --- Tests ---

describe("source-bindings GET — name derivation", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("uses notes as name when notes is set", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-named");
    await seedBinding(f.raw, dom.id, "drive", { notes: "My Drive binding" });

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.name === "My Drive binding");
    expect(found).toBeDefined();
  });

  it("falls back to adapter → domain when notes is null", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-exec");
    await seedBinding(f.raw, dom.id, "asana");

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.name === "asana → wiki-exec");
    expect(found).toBeDefined();
  });
});

describe("source-bindings GET — 3-state status: ALERT", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns alert when ingestion_intake has an error_class in the last 24h", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-alert-intake");
    const bnd = await seedBinding(f.raw, dom.id, "drive");
    await seedWebhookEvent(f.raw, bnd.id, { ageHours: 1 });
    await seedIntakeRow(f.raw, bnd.id, { errorClass: "transient", ageHours: 0.5 });

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found?.status).toBe("alert");
  });

  it("returns alert when there is a sig-fail in the last 24h", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-alert-sigfail");
    const bnd = await seedBinding(f.raw, dom.id, "fireflies");
    await seedWebhookEvent(f.raw, bnd.id, { signatureOk: true, ageHours: 1 });
    await seedWebhookEvent(f.raw, bnd.id, { signatureOk: false, ageHours: 0.5 });

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found?.status).toBe("alert");
  });
});

describe("source-bindings GET — 3-state status: ADVISORY", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns advisory when the last event was >24h ago on an enabled binding", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-advisory-stale");
    const bnd = await seedBinding(f.raw, dom.id, "drive", { enabled: true });
    // Last event was 48h ago — stale
    await seedWebhookEvent(f.raw, bnd.id, { ageHours: 48 });

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found?.status).toBe("advisory");
  });

  it("returns advisory when no events in last 7d but there are older events", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-advisory-idle");
    const bnd = await seedBinding(f.raw, dom.id, "drive", { enabled: true });
    // Event was 10 days ago — idle
    await seedWebhookEvent(f.raw, bnd.id, { ageHours: 240 });

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found?.status).toBe("advisory");
  });
});

describe("source-bindings GET — 3-state status: HEALTHY", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns healthy when events arrive normally with no failures", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-healthy");
    const bnd = await seedBinding(f.raw, dom.id, "drive", { enabled: true });
    // Recent event, no sig fail, no intake error
    await seedWebhookEvent(f.raw, bnd.id, { ageHours: 1, signatureOk: true });

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found?.status).toBe("healthy");
    expect(found?.lastEventAt).not.toBeNull();
  });
});

describe("source-bindings GET — neutral cases (null status)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns null status for an enabled binding with no events ever (newly created)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-new");
    const bnd = await seedBinding(f.raw, dom.id, "drive", { enabled: true });

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found?.status).toBeNull();
    expect(found?.lastEventAt).toBeNull();
  });

  it("returns null status for a disabled binding regardless of event history", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-disabled-status");
    const bnd = await seedBinding(f.raw, dom.id, "drive", { enabled: false });
    // Seed an old event for this disabled binding
    await seedWebhookEvent(f.raw, bnd.id, { ageHours: 100, signatureOk: false });

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found?.status).toBeNull();
  });
});

describe("source-bindings GET — lastError sanitization (THREAT-MODEL §3.6 invariant 11)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("scrubs a PAT embedded in an error_class string before returning it", async () => {
    // Synthetic test: we store a fake error_class that contains what looks
    // like a PAT. The response must NOT contain the raw PAT bytes.
    // (In production, error_class is an enum; this exercises the scrub path
    // for the broader last_error field construction.)
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-scrub-test");
    const bnd = await seedBinding(f.raw, dom.id, "drive");
    await seedWebhookEvent(f.raw, bnd.id, { ageHours: 1 });
    // Inject a fake "error_class" that contains a PAT-like string.
    // We bypass Drizzle's enum by writing raw SQL to set the value.
    const fakePat = "1/1234567890123456";
    // Store in ingestion_intake with a synthetic error_class that contains the PAT.
    // This simulates a case where an error message leaks into the error_class field.
    await f.raw.query(
      `INSERT INTO ingestion_intake
         (binding_id, source_doc_id, source_revision, content_hash, status, error_class, created_at)
       VALUES ($1::uuid, $2, 'rev1', 'ch1', 'failed', $3, NOW() - '1 hour'::interval)`,
      [bnd.id, "scrub-doc", `transient:${fakePat}`],
    );

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    // The lastError field must not contain the raw PAT bytes.
    expect(found?.lastError).toBeDefined();
    expect(found?.lastError).not.toContain(fakePat);
    expect(found?.lastError).toContain("[REDACTED]");
  });

  it("truncates lastError to 200 characters", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-truncate-test");
    const bnd = await seedBinding(f.raw, dom.id, "drive");
    await seedWebhookEvent(f.raw, bnd.id, { ageHours: 1 });
    const longError = "x".repeat(300);
    await f.raw.query(
      `INSERT INTO ingestion_intake
         (binding_id, source_doc_id, source_revision, content_hash, status, error_class, created_at)
       VALUES ($1::uuid, $2, 'rev1', 'ch1', 'failed', $3, NOW() - '1 hour'::interval)`,
      [bnd.id, "long-err-doc", longError],
    );

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found?.lastError).toBeDefined();
    expect(found?.lastError!.length).toBeLessThanOrEqual(200);
  });
});
