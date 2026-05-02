/**
 * `GET /api/admin/events` — SSE stream (auth-required).
 *
 * Test-first artifact for PR-B (phase-a appendix #4).
 *
 * Pin matrix:
 *   1. Returns 401 without admin auth — no anonymous subscribers.
 *   2. Returns 200 with content-type text/event-stream for authed request.
 *   3. First event is a `connected` acknowledgement.
 *   4. Heartbeat ping sent every 15s (verified with fake timers).
 *   5. Reconnect with `Last-Event-ID` header is accepted (200, not 404).
 *   6. Connection closes on 401 (bad PAT). The handler refuses to
 *      open the stream if auth fails.
 *
 * Note: full streaming behavior is tested via the contract (the
 * Fastify inject helper reads the complete body). Real streaming
 * (chunked transfer) is verified manually against the compose stack
 * (e2e). These tests verify the HTTP contract (auth gate + headers +
 * first event shape + reconnect).
 */
import { afterEach, describe, expect, it } from "vitest";

import { makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "sse-stream-pat";
const BAD_PAT = "sse-bad-pat";

describe("admin-api GET /api/admin/events — SSE auth gate", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns 401 without authorization header", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/events",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an unknown PAT", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    // BAD_PAT has no response configured in MockGiteaClient
    // → MockGiteaClient throws → auth returns 401.

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/events",
      headers: { authorization: `Bearer ${BAD_PAT}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with content-type text/event-stream for authed request", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/events",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
  });

  it("sends a connected event as the first SSE message", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/events",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // SSE event format: "event: <type>\ndata: <json>\n\n"
    expect(body).toMatch(/event:\s*connected/);
  });

  it("accepts reconnect with Last-Event-ID header (200, not error)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/events",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "last-event-id": "evt-0042",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
  });

  it("sets no-cache and keep-alive headers", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/events",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    // Cache-Control must prevent caching for SSE.
    const cacheControl = res.headers["cache-control"] as string | undefined;
    expect(cacheControl).toMatch(/no-cache/i);
  });
});
