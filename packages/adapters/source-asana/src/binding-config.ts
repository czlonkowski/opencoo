/**
 * Binding-config schema for the Asana SourceAdapter (PR 24 /
 * plan #115).
 *
 * Asana is webhook-mode — the engine-ingestion receiver
 * (PR 14) accepts inbound `POST /webhooks/asana` requests,
 * resolves the binding by webhook target URL or path id, and
 * uses the adapter's `webhook.verifier` + helpers to process
 * the event. The webhook setup handshake (`X-Hook-Secret`
 * echo on first registration) is documented in the adapter
 * README; the actual handshake endpoint lands in PR 30.
 */
import { z } from "zod";

export const asanaBindingConfigSchema = z
  .object({
    /** Asana project gid the adapter watches. The receiver
     *  matches inbound events against this. */
    projectGid: z.string().min(1),
    /** Optional workspace gid for cross-checks. The PoC keys
     *  the project-to-workspace mapping in a separate table;
     *  v0.1 carries it on the binding for symmetric audit. */
    workspaceGid: z.string().min(1).optional(),
    /** Reference to the webhook secret persisted in the
     *  CredentialStore. The receiver fetches the actual bytes
     *  via this reference at verify-time. */
    webhookSecretCredentialId: z.string().min(1),
    /** Operator review mode. Default `auto` — the engine
     *  ingests Asana events without per-doc review. NOTE:
     *  `auto` requires the redaction guard (PR 12) wired into
     *  the ingestion path (untrusted Asana task bodies can
     *  carry adversarial content). */
    reviewMode: z.enum(["auto", "review"]).default("auto"),
  })
  .strict();

export type AsanaBindingConfig = z.infer<typeof asanaBindingConfigSchema>;
