/**
 * api.ts tests — auto-retry on 403 csrf_invalid + auth-error
 * mapping + PAT/CSRF header injection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiAuthError,
  ApiTransientError,
  ApiValidationError,
  fetchAdmin,
} from "../../src/lib/api.js";

beforeEach(() => {
  // Seed a PAT in sessionStorage so the wrapper sends Authorization.
  window.sessionStorage.setItem("opencoo_pat", "test-pat");
  // Seed a CSRF cookie.
  document.cookie = "opencoo_csrf=csrf-token; path=/";
});

afterEach(() => {
  window.sessionStorage.clear();
  document.cookie = "opencoo_csrf=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
});

describe("fetchAdmin", () => {
  it("attaches Bearer + CSRF headers on POST", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await fetchAdmin("/api/admin/x", { method: "POST", body: { y: 1 }, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/admin/x");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers["authorization"]).toBe("Bearer test-pat");
    expect(headers["x-csrf-token"]).toBe("csrf-token");
    expect(headers["content-type"]).toBe("application/json");
    expect((init as RequestInit).body).toBe(JSON.stringify({ y: 1 }));
  });

  it("does NOT set content-type or body when caller omits body (PR-W7)", async () => {
    // Regression for FST_ERR_CTP_EMPTY_JSON_BODY: Fastify rejects an
    // empty body with HTTP 400 when content-type:application/json is
    // present. The R7 forget dialog (dryRun=1 + dryRun=0) and the
    // logout endpoint both POST without a body.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await fetchAdmin("/api/admin/x", { method: "POST", fetchImpl });
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers["content-type"]).toBeUndefined();
    expect((init as RequestInit).body).toBeUndefined();
    // Auth + CSRF still attached — only content-type is gated on body.
    expect(headers["authorization"]).toBe("Bearer test-pat");
    expect(headers["x-csrf-token"]).toBe("csrf-token");
  });

  it("auto-retries ONCE on 403 csrf_invalid after refetching /_csrf", async () => {
    const fetchImpl = vi
      .fn()
      // First call → 403 csrf_invalid.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "csrf_invalid", reason: "csrf_mismatch" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      )
      // Second call → /_csrf refresh.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "fresh", username: "alice" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      // Third call → original POST retried, succeeds.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const result = await fetchAdmin<{ ok: boolean }>("/api/admin/x", {
      method: "POST",
      body: { y: 1 },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const refreshCallUrl = fetchImpl.mock.calls[1]![0];
    expect(refreshCallUrl).toBe("/api/admin/_csrf");
  });

  it("does NOT retry a 403 csrf_invalid more than once (no infinite loop)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "csrf_invalid", reason: "csrf_mismatch" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      fetchAdmin("/api/admin/x", { method: "POST", fetchImpl }),
    ).rejects.toBeInstanceOf(ApiAuthError);
    // First original POST + refresh + retried POST = 3 calls; no
    // second retry.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("maps 401 to ApiAuthError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized", reason: "missing_authorization_header" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(fetchAdmin("/api/admin/x", { fetchImpl })).rejects.toBeInstanceOf(
      ApiAuthError,
    );
  });

  it("maps 4xx (other) to ApiValidationError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "validation_failed" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(fetchAdmin("/api/admin/x", { method: "POST", fetchImpl })).rejects.toBeInstanceOf(
      ApiValidationError,
    );
  });

  it("maps 5xx to ApiTransientError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("server down", { status: 503 }),
    );
    await expect(fetchAdmin("/api/admin/x", { fetchImpl })).rejects.toBeInstanceOf(
      ApiTransientError,
    );
  });
});
