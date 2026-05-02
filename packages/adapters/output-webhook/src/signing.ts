/**
 * Outgoing request signing for output-webhook (PR-J).
 *
 * # Outgoing signature
 *
 *   Header: `X-OpenCoo-Signature: <hex>`
 *   Algorithm: HMAC-SHA256 over the raw body bytes using the signing secret.
 *   Output: 64 lowercase hex characters.
 *
 * # Delivery ID derivation
 *
 *   Header: `X-OpenCoo-Delivery-Id: <uuid>`
 *   Derivation: UUID v5 (SHA-1 name-based) from a stable namespace + a
 *   name built as `${bindingId}:${payloadHash}` where `payloadHash` is
 *   the hex SHA-256 of the serialized body bytes.
 *
 *   Determinism: replaying the same payload to the same binding produces
 *   the same delivery ID. The receiver uses this for idempotency.
 *
 * THREAT-MODEL §3.6 invariant 11:
 *   The signing secret bytes are NEVER embedded in any string that
 *   could appear in error messages, delivery IDs, or any output. Only
 *   the computed HMAC hex digest is emitted.
 */
import { createHash, createHmac } from "node:crypto";

/** opencoo delivery-id namespace UUID (RFC 4122 v5 name-based).
 *  This is the well-known RFC 4122 DNS namespace UUID, not randomly
 *  assigned. Stable — changing this would break idempotency for all
 *  existing receivers. */
const DELIVERY_ID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Compute HMAC-SHA256 over `bodyBytes` using `secret`.
 * Returns lowercase hex (64 characters).
 *
 * THREAT-MODEL §3.6 invariant 11: `secret` bytes never appear in output.
 */
export function computeHmac(bodyBytes: Buffer, secret: Buffer): string {
  return createHmac("sha256", secret).update(bodyBytes).digest("hex");
}

/**
 * Derive a deterministic UUID v5 delivery ID from the binding ID and
 * the SHA-256 of the body bytes.
 *
 * The derivation is:
 *   1. `payloadHash = sha256(bodyBytes)` as hex.
 *   2. `name = "${bindingId}:${payloadHash}"`
 *   3. UUID v5 = sha1(DELIVERY_ID_NAMESPACE_BYTES + name) formatted as UUID.
 *
 * Determinism: same bindingId + same body → same delivery ID.
 * Different body → different hash → different UUID.
 *
 * The `bindingId` parameter may be any stable identifier that scopes
 * deliveries. When a SourceBindingId is not available (e.g. in tests),
 * any stable string works.
 */
export function deriveDeliveryId(
  bindingId: string,
  bodyBytes: Buffer,
): string {
  const payloadHash = createHash("sha256").update(bodyBytes).digest("hex");
  const name = `${bindingId}:${payloadHash}`;

  // UUID v5: SHA-1 of namespace bytes + name bytes, formatted as UUID.
  // Namespace bytes: DELIVERY_ID_NAMESPACE as raw bytes (RFC 4122).
  const nsBytes = Buffer.from(
    DELIVERY_ID_NAMESPACE.replace(/-/g, ""),
    "hex",
  );
  const nameBytes = Buffer.from(name, "utf8");
  const combined = Buffer.concat([nsBytes, nameBytes]);
  const sha1 = createHash("sha1").update(combined).digest();

  // Set version (4 bits = 5) and variant (2 bits = 0b10) per RFC 4122.
  sha1[6] = (sha1[6]! & 0x0f) | 0x50; // version 5
  sha1[8] = (sha1[8]! & 0x3f) | 0x80; // variant 10xx

  const hex = sha1.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
