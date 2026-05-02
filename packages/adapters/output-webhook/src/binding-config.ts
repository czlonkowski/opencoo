/**
 * Binding config schema for the output-webhook adapter (PR-J).
 *
 * # Security invariants
 *
 * - `headers` MUST NOT contain `Authorization` (case-insensitive).
 *   Credentials route through `signingSecretCredentialId` only.
 *   Enforced by Zod `.refine()` at config-validate time so the error
 *   surfaces immediately at adapter creation, not on first write.
 *   (THREAT-MODEL §3.6 invariant 11)
 *
 * - `signingSecretCredentialId` is the credential ID (not the raw
 *   secret). The raw bytes are resolved from the CredentialStore at
 *   write time and never stored in the binding config.
 */
import { z } from "zod";

export const retryPolicySchema = z.object({
  /** Maximum number of HTTP attempts (first attempt + retries). Default: 5. */
  maxAttempts: z.number().int().min(1).max(20).default(5),
  /** Base delay in milliseconds for exponential backoff. Default: 500. */
  baseDelayMs: z.number().int().min(0).default(500),
});

export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
};

/**
 * Checks that `headers` does not contain an `Authorization` key
 * (case-insensitive). Credentials route through the signing-secret
 * only — operator-configurable headers are for metadata, not auth.
 */
function hasNoAuthorizationHeader(
  headers: Record<string, string>,
): boolean {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization") return false;
  }
  return true;
}

export const webhookOutputBindingConfigSchema = z
  .object({
    /** Full URL to POST payloads to. */
    targetUrl: z.string().url(),
    /** Credential ID for the HMAC signing secret. The Management UI
     *  stores the raw bytes in the CredentialStore; only the ID is
     *  persisted in the binding config. */
    signingSecretCredentialId: z.string().min(1),
    /** Retry policy for transient HTTP failures. */
    retryPolicy: retryPolicySchema.default(DEFAULT_RETRY_POLICY),
    /** Optional operator-configured HTTP headers appended to every
     *  outgoing request. `Authorization` is forbidden (use the
     *  signingSecretCredentialId instead). */
    headers: z.record(z.string(), z.string()).default({}),
  })
  .refine((val) => hasNoAuthorizationHeader(val.headers), {
    message:
      "headers must not contain 'Authorization' — credentials route through signingSecretCredentialId only (THREAT-MODEL §3.6 invariant 11)",
    path: ["headers"],
  });

export type WebhookOutputBindingConfig = z.infer<
  typeof webhookOutputBindingConfigSchema
>;
