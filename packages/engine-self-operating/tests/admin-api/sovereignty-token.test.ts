/**
 * Sovereignty-diff token unit tests (PR 28 / plan #128,
 * THREAT-MODEL §3.13).
 *
 * The token is the load-bearing replay-protection for two-step
 * confirm of LLM-policy edits. Every failure mode gets a named
 * test:
 *   - happy path: issue → verify → ok
 *   - tampered hmac → signature_mismatch
 *   - expired → expired
 *   - replay against a different payload → payload_mismatch
 *   - malformed token → malformed
 *
 * `computePayloadHash` is canonical (sorted-key JSON), so two
 * objects with the same content but different key order produce
 * the same hash.
 */
import { describe, expect, it } from "vitest";

import {
  SOVEREIGNTY_TOKEN_TTL_MS,
  computePayloadHash,
  issueSovereigntyDiffToken,
  verifySovereigntyDiffToken,
} from "../../src/admin-api/sovereignty-token.js";

const KEY = Buffer.from("test-sovereignty-key-32-bytes-xx");

describe("sovereignty-token — computePayloadHash", () => {
  it("is stable across object-key order (canonical sort)", () => {
    const a = computePayloadHash({
      domainId: "d1",
      proposed: { provider: "anthropic", model: "claude-3" },
    });
    const b = computePayloadHash({
      domainId: "d1",
      proposed: { model: "claude-3", provider: "anthropic" },
    });
    expect(a).toBe(b);
  });

  it("differs when domainId differs (replay-protection across domains)", () => {
    const a = computePayloadHash({ domainId: "d1", proposed: { x: 1 } });
    const b = computePayloadHash({ domainId: "d2", proposed: { x: 1 } });
    expect(a).not.toBe(b);
  });

  it("differs when proposed differs", () => {
    const a = computePayloadHash({ domainId: "d1", proposed: { x: 1 } });
    const b = computePayloadHash({ domainId: "d1", proposed: { x: 2 } });
    expect(a).not.toBe(b);
  });
});

describe("sovereignty-token — issue + verify", () => {
  it("issues a token and verifies it on the same payload (happy path)", () => {
    const payload = {
      domainId: "11111111-1111-1111-1111-111111111111",
      proposed: { provider: "openai", model: "gpt-4o" },
    };
    const { token, expiresAt } = issueSovereigntyDiffToken({
      key: KEY,
      payload,
    });
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const result = verifySovereigntyDiffToken({
      key: KEY,
      token,
      currentPayload: payload,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered HMAC segment (signature_mismatch)", () => {
    const payload = { domainId: "d1", proposed: { x: 1 } };
    const { token } = issueSovereigntyDiffToken({ key: KEY, payload });
    const parts = token.split(".");
    // Flip the first char of the HMAC segment.
    const flipped = (parts[0]!.startsWith("A") ? "B" : "A") + parts[0]!.slice(1);
    const tampered = [flipped, parts[1], parts[2]].join(".");
    const result = verifySovereigntyDiffToken({
      key: KEY,
      token: tampered,
      currentPayload: payload,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("signature_mismatch");
    }
  });

  it("rejects when verifying with a different signing key", () => {
    const payload = { domainId: "d1", proposed: { x: 1 } };
    const { token } = issueSovereigntyDiffToken({ key: KEY, payload });
    const result = verifySovereigntyDiffToken({
      key: Buffer.from("different-key-32-bytes-xxxxxxxxx"),
      token,
      currentPayload: payload,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("signature_mismatch");
    }
  });

  it("rejects when payload changed between preview and apply (payload_mismatch — replay-protection)", () => {
    const previewPayload = { domainId: "d1", proposed: { provider: "openai" } };
    const { token } = issueSovereigntyDiffToken({
      key: KEY,
      payload: previewPayload,
    });
    const tamperedApplyPayload = {
      domainId: "d1",
      proposed: { provider: "anthropic" }, // ← changed
    };
    const result = verifySovereigntyDiffToken({
      key: KEY,
      token,
      currentPayload: tamperedApplyPayload,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("payload_mismatch");
    }
  });

  it("rejects when the domainId differs (cross-domain replay)", () => {
    const previewPayload = { domainId: "d1", proposed: { x: 1 } };
    const { token } = issueSovereigntyDiffToken({
      key: KEY,
      payload: previewPayload,
    });
    const result = verifySovereigntyDiffToken({
      key: KEY,
      token,
      currentPayload: { domainId: "d2", proposed: { x: 1 } },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("payload_mismatch");
    }
  });

  it("rejects expired tokens", () => {
    const payload = { domainId: "d1", proposed: { x: 1 } };
    const fixedNow = 1_700_000_000_000;
    const { token } = issueSovereigntyDiffToken({
      key: KEY,
      payload,
      now: () => fixedNow,
    });
    const result = verifySovereigntyDiffToken({
      key: KEY,
      token,
      currentPayload: payload,
      now: () => fixedNow + SOVEREIGNTY_TOKEN_TTL_MS + 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("expired");
    }
  });

  it("rejects malformed tokens (wrong segment count)", () => {
    const payload = { domainId: "d1", proposed: { x: 1 } };
    const result = verifySovereigntyDiffToken({
      key: KEY,
      token: "garbage",
      currentPayload: payload,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("malformed");
    }
  });

  it("rejects tokens with non-numeric expiresAt segment", () => {
    const payload = { domainId: "d1", proposed: { x: 1 } };
    const result = verifySovereigntyDiffToken({
      key: KEY,
      token: "sig.hash.notanumber",
      currentPayload: payload,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe("malformed");
    }
  });

  it("TTL is exactly 5 minutes (planner Q5)", () => {
    expect(SOVEREIGNTY_TOKEN_TTL_MS).toBe(5 * 60 * 1000);
  });
});
