/**
 * `GET /api/admin/source-bindings` — `intakeCounts` + `recentFailedIntake`
 * (PR-W4, phase-a appendix #14).
 *
 * W3 made compile-worker failures visible in the DB by adding the
 * `'failed'` terminal state on `intake_status` and writing
 * `error_class` / `error_text` from the worker's catch. W4 surfaces
 * that visibility on the GET so the SourceBindingDetail "Intake state"
 * panel can render counts + the most-recent failures without a
 * second round-trip.
 *
 * Pin matrix:
 *   1. A binding with zero intake rows returns `intakeCounts` with
 *      every status defaulted to `0`.
 *   2. A binding with rows in multiple states returns the right
 *      counts (`pending`, `classified`, `skipped`, `failed`).
 *   3. `recentFailedIntake` returns up to 3 most-recent `failed`
 *      rows, newest-first.
 *   4. `error_text` snippet is truncated to 200 chars at the query
 *      (LEFT(error_text, 200)) — defensive against W3's 1000-char
 *      cap drifting upward in the future.
 *   5. Snippet is scrubbed via `safeErrorMessage` so credential bytes
 *      leaking into the error_text column don't escape on the GET.
 *   6. Counts + recent rows for one binding don't bleed into another
 *      binding's response (binding_id scope).
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-intake-counts";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "carol",
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
): Promise<{ readonly id: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled)
     VALUES ($1::uuid, $2, 'auto'::review_mode, true) RETURNING id::text AS id`,
    [domainId, adapterSlug],
  );
  return { id: r.rows[0]!.id };
}

/** Seed an ingestion_intake row in a specific state.
 *
 *  `errorClass` + `errorText` are written only when status='failed'
 *  to mirror the W3 worker behavior (the success path clears both).
 *  `ageSeconds` controls `created_at` so tests can pin ordering for
 *  `recent_failed_intake`. */
async function seedIntake(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  bindingId: string,
  opts: {
    readonly status: "pending" | "classified" | "skipped" | "failed";
    readonly errorClass?: "validation" | "transient" | "upstream-quota";
    readonly errorText?: string;
    readonly ageSeconds?: number;
    readonly docId?: string;
  },
): Promise<{ readonly id: string }> {
  const age = opts.ageSeconds ?? 0;
  const docId =
    opts.docId ?? `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await raw.query<{ id: string }>(
    `INSERT INTO ingestion_intake
       (binding_id, source_doc_id, source_revision, content_hash, status, error_class, error_text, created_at)
     VALUES ($1::uuid, $2, 'rev1', 'ch1', $3::intake_status, $4, $5, NOW() - ($6 || ' seconds')::interval)
     RETURNING id::text AS id`,
    [
      bindingId,
      docId,
      opts.status,
      opts.errorClass ?? null,
      opts.errorText ?? null,
      String(age),
    ],
  );
  return { id: r.rows[0]!.id };
}

interface BindingResponseRow {
  readonly id: string;
  readonly intakeCounts?: {
    readonly pending: number;
    readonly classified: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly recentFailedIntake?: ReadonlyArray<{
    readonly id: string;
    readonly errorClass: string | null;
    readonly errorTextSnippet: string | null;
  }>;
}

async function getBindings(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
  pat: string,
): Promise<{ readonly rows: ReadonlyArray<BindingResponseRow> }> {
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
    rows: BindingResponseRow[];
  };
}

describe("source-bindings GET — intakeCounts + recentFailedIntake (PR-W4)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns zeroed counts when the binding has no intake rows", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-counts-none");
    const bnd = await seedBinding(f.raw, dom.id, "drive");

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found).toBeDefined();
    expect(found?.intakeCounts).toEqual({
      pending: 0,
      classified: 0,
      skipped: 0,
      failed: 0,
    });
    expect(found?.recentFailedIntake).toEqual([]);
  });

  it("returns correct per-status counts across multiple intake rows", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-counts-mixed");
    const bnd = await seedBinding(f.raw, dom.id, "drive");

    // 5 pending, 2 classified, 1 skipped, 3 failed
    for (let i = 0; i < 5; i += 1) {
      await seedIntake(f.raw, bnd.id, { status: "pending" });
    }
    for (let i = 0; i < 2; i += 1) {
      await seedIntake(f.raw, bnd.id, { status: "classified" });
    }
    await seedIntake(f.raw, bnd.id, { status: "skipped" });
    for (let i = 0; i < 3; i += 1) {
      await seedIntake(f.raw, bnd.id, {
        status: "failed",
        errorClass: "validation",
        errorText: `failure ${i}`,
      });
    }

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found?.intakeCounts).toEqual({
      pending: 5,
      classified: 2,
      skipped: 1,
      failed: 3,
    });
  });

  it("returns up to 3 most-recent failed rows newest-first", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-recent-failed");
    const bnd = await seedBinding(f.raw, dom.id, "drive");

    // 5 failed rows with descending recency; expect only the
    // 3 newest in the response in newest-first order.
    await seedIntake(f.raw, bnd.id, {
      status: "failed",
      errorClass: "validation",
      errorText: "oldest",
      ageSeconds: 500,
    });
    await seedIntake(f.raw, bnd.id, {
      status: "failed",
      errorClass: "validation",
      errorText: "second-oldest",
      ageSeconds: 400,
    });
    await seedIntake(f.raw, bnd.id, {
      status: "failed",
      errorClass: "transient",
      errorText: "third",
      ageSeconds: 300,
    });
    await seedIntake(f.raw, bnd.id, {
      status: "failed",
      errorClass: "transient",
      errorText: "second",
      ageSeconds: 200,
    });
    await seedIntake(f.raw, bnd.id, {
      status: "failed",
      errorClass: "upstream-quota",
      errorText: "newest",
      ageSeconds: 100,
    });

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found?.recentFailedIntake).toHaveLength(3);
    expect(found?.recentFailedIntake?.[0]?.errorTextSnippet).toBe("newest");
    expect(found?.recentFailedIntake?.[1]?.errorTextSnippet).toBe("second");
    expect(found?.recentFailedIntake?.[2]?.errorTextSnippet).toBe("third");
  });

  it("truncates errorTextSnippet to 200 chars at the query", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-snippet-trunc");
    const bnd = await seedBinding(f.raw, dom.id, "drive");

    // W3 caps error_text at 1000 chars; W4 truncates the SNIPPET at
    // the GET to 200 to bound row size and downstream UI exposure.
    // Use ordinary prose so the scrub helper doesn't treat the text
    // as a high-entropy token and redact the whole thing (the scrub
    // assertion lives in its own test below).
    const longText = (
      "intake failure — pipeline rejected the source. Reason: payload schema mismatch on the upstream adapter. Details follow. "
    ).repeat(30);
    await seedIntake(f.raw, bnd.id, {
      status: "failed",
      errorClass: "validation",
      errorText: longText,
    });

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    const snippet = found?.recentFailedIntake?.[0]?.errorTextSnippet;
    expect(snippet).not.toBeNull();
    // Query-side `LEFT(error_text, 200)` caps the raw column read.
    // `safeErrorMessage` applies the shared ERROR_MESSAGE_MAX_LENGTH
    // cap on top of that; both ceilings keep the snippet ≤200 chars.
    expect(snippet!.length).toBeLessThanOrEqual(200);
    expect(snippet!.length).toBeGreaterThan(0);
    // The truncation is at the BYTE level, so the snippet should
    // start with the same prefix the column does.
    expect(snippet!.startsWith("intake failure")).toBe(true);
  });

  it("scrubs credential bytes from errorTextSnippet (THREAT-MODEL §3.6 inv 11)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-snippet-scrub");
    const bnd = await seedBinding(f.raw, dom.id, "drive");

    // Construct a 40+ char hex-shaped token that `scrubPat` should
    // redact. Mirrors `safeErrorMessage` invariant used elsewhere in
    // the GET handler (`lastError` already scrubs).
    const fakePat = "ghp_" + "a".repeat(36);
    const errorText = `Auth failed with token ${fakePat} (validation)`;
    await seedIntake(f.raw, bnd.id, {
      status: "failed",
      errorClass: "validation",
      errorText,
    });

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    const snippet = found?.recentFailedIntake?.[0]?.errorTextSnippet;
    expect(snippet).not.toBeNull();
    expect(snippet).not.toContain(fakePat);
  });

  it("does not bleed counts or recent-failed rows across bindings", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-scope");
    const bnd1 = await seedBinding(f.raw, dom.id, "drive");
    const bnd2 = await seedBinding(f.raw, dom.id, "fireflies");

    // bnd1 has 3 failed rows; bnd2 has 0 failed rows.
    for (let i = 0; i < 3; i += 1) {
      await seedIntake(f.raw, bnd1.id, {
        status: "failed",
        errorClass: "validation",
        errorText: `bnd1-failure-${i}`,
      });
    }
    // bnd2 has 4 classified rows but no failures.
    for (let i = 0; i < 4; i += 1) {
      await seedIntake(f.raw, bnd2.id, { status: "classified" });
    }

    const body = await getBindings(f, ADMIN_PAT);
    const found1 = body.rows.find((b) => b.id === bnd1.id);
    const found2 = body.rows.find((b) => b.id === bnd2.id);
    expect(found1?.intakeCounts?.failed).toBe(3);
    expect(found1?.recentFailedIntake?.length).toBe(3);
    expect(found2?.intakeCounts?.failed).toBe(0);
    expect(found2?.intakeCounts?.classified).toBe(4);
    expect(found2?.recentFailedIntake).toEqual([]);
  });
});
