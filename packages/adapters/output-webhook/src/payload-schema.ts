/**
 * Webhook output payload schema (PR-J).
 *
 * The schema is `.strict()` per the OutputAdapter contract
 * suite assertion 8 — over-keyed payloads fail Zod-parse
 * BEFORE any external call. Defense-in-depth against agent
 * field-smuggling.
 *
 * Shape is intentionally generic:
 *   - `event` — event type identifier (e.g. "heartbeat.report",
 *     "lint.finding", "surfacer.candidate"). Namespaced with `.`
 *     for readability in receiver routing.
 *   - `data` — JSON object payload (string-keyed record; not arrays
 *     or bare primitives). The webhook receiver parses and routes
 *     based on `event`; opencoo does not interpret `data` contents.
 *
 * Body size cap: 1 MiB (mirrors the source-webhook ceiling). The
 * body is serialized to JSON in the adapter; validation is against
 * the logical structure, not byte count.
 */
import { z } from "zod";

export const webhookPayloadSchema = z
  .object({
    /** Event type identifier. Non-empty, namespaced with `.`. */
    event: z.string().min(1).max(256),
    /** Arbitrary JSON data for the receiver. Bounded to prevent
     *  runaway payloads from LLM output. */
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
