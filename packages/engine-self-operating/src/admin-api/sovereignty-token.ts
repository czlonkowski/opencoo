/**
 * Sovereignty-diff token — stateless HMAC-signed bearer for the
 * "you're about to change LLM policy on domain X; here's the
 * diff" two-step confirm flow (PR 28 / plan #128, THREAT-MODEL
 * §3.13).
 *
 * Flow:
 *   1. Client POSTs to `/api/admin/domains/:id/llm-policy/preview`
 *      with the proposed policy.
 *   2. Server computes the diff, returns it + a SIGNED token
 *      that binds `(domainId, proposedPolicyHash)`.
 *   3. Operator reviews the diff in the UI.
 *   4. Client POSTs to `/api/admin/domains/:id/llm-policy/apply`
 *      with the same proposed policy + the token.
 *   5. Server verifies the token is valid AND the
 *      `payloadHash` in the token matches the hash of the
 *      currently-submitted policy (replay-protection — a token
 *      issued for policy A can't be replayed against policy B).
 *   6. Server applies the change.
 *
 * Why HMAC-signed not session-bound: stateless servers, no
 * Redis dependency for the admin API. The `SESSION_HMAC_KEY`
 * env var is the signing key; rotating it invalidates all
 * outstanding tokens (acceptable — operator just regenerates
 * the diff).
 *
 * Token format:
 *   `<hmacB64Url>.<payloadHashB64Url>.<expiresAtMs>`
 * where `hmacB64Url = HMAC-SHA256(key, "v1|payloadHash|expiresAtMs")`.
 *
 * TTL: 5 minutes (planner Q5, fixed — not operator-configurable).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 5 * 60 * 1000;
const TOKEN_VERSION = "v1";

export interface SovereigntyDiffPayload {
  readonly domainId: string;
  /** Proposed value the token binds to. Hashed; the token does
   *  NOT carry the value itself so size stays bounded. */
  readonly proposed: unknown;
}

/**
 * Compute the canonical hash of a sovereignty-diff payload.
 * Sorted-key JSON so the hash is stable across any equivalent
 * `proposed` value the client sends; sha256, base64url, no
 * padding.
 *
 * The hash includes `domainId` so a token issued for domain A's
 * policy CANNOT be replayed against domain B even if the
 * `proposed` policy is identical.
 */
export function computePayloadHash(payload: SovereigntyDiffPayload): string {
  const canonical = JSON.stringify({
    domainId: payload.domainId,
    proposed: canonicalize(payload.proposed),
  });
  return createHash("sha256").update(canonical).digest("base64url");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = canonicalize(obj[k]);
    }
    return out;
  }
  return value;
}

export interface IssueDiffTokenArgs {
  readonly key: Buffer;
  readonly payload: SovereigntyDiffPayload;
  readonly now?: () => number;
}

export function issueSovereigntyDiffToken(
  args: IssueDiffTokenArgs,
): { readonly token: string; readonly expiresAt: number } {
  const now = args.now ?? ((): number => Date.now());
  const expiresAt = now() + TOKEN_TTL_MS;
  const payloadHash = computePayloadHash(args.payload);
  const signed = signCore(args.key, payloadHash, expiresAt);
  return { token: `${signed}.${payloadHash}.${expiresAt}`, expiresAt };
}

function signCore(key: Buffer, payloadHash: string, expiresAt: number): string {
  const message = `${TOKEN_VERSION}|${payloadHash}|${expiresAt}`;
  return createHmac("sha256", key).update(message).digest("base64url");
}

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: VerifyFailureReason };

export type VerifyFailureReason =
  | "malformed"
  | "expired"
  | "signature_mismatch"
  | "payload_mismatch";

export interface VerifyDiffTokenArgs {
  readonly key: Buffer;
  readonly token: string;
  /** Re-derive the payload hash from the request body so a
   *  token issued for payload A can't be replayed against
   *  payload B. The verifier rejects if this doesn't match the
   *  hash baked into the token. */
  readonly currentPayload: SovereigntyDiffPayload;
  readonly now?: () => number;
}

export function verifySovereigntyDiffToken(
  args: VerifyDiffTokenArgs,
): VerifyResult {
  const now = args.now ?? ((): number => Date.now());
  const parts = args.token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed" };
  }
  const [signed, payloadHash, expiresAtRaw] = parts as [string, string, string];
  const expiresAt = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { ok: false, reason: "malformed" };
  }
  if (now() >= expiresAt) {
    return { ok: false, reason: "expired" };
  }

  // Replay-protection: re-derive the payload hash from the
  // currently-submitted body. If it doesn't match the hash
  // baked into the token, the operator changed the proposed
  // payload between preview and apply — reject.
  const expectedPayloadHash = computePayloadHash(args.currentPayload);
  const lhs = Buffer.from(payloadHash, "utf8");
  const rhs = Buffer.from(expectedPayloadHash, "utf8");
  if (lhs.length !== rhs.length || !timingSafeEqual(lhs, rhs)) {
    return { ok: false, reason: "payload_mismatch" };
  }

  // Signature check.
  const expectedSigned = signCore(args.key, payloadHash, expiresAt);
  const sigLhs = Buffer.from(signed, "utf8");
  const sigRhs = Buffer.from(expectedSigned, "utf8");
  if (sigLhs.length !== sigRhs.length || !timingSafeEqual(sigLhs, sigRhs)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return { ok: true };
}

export const SOVEREIGNTY_TOKEN_TTL_MS = TOKEN_TTL_MS;
