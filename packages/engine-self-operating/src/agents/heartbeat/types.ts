/**
 * Heartbeat agent output schema. The LLM returns this exact
 * shape via `router.generateObject`; Zod-strict parses fail-
 * closed as `LlmProviderError(validation)` → DLQ.
 *
 * Invariants enforced by the schema (architecture §9.4):
 *   - At most 5 alerts. Quality over quantity; an empty array
 *     is a valid "nothing to surface" day.
 *   - Lead with priority-1 — index 0 must carry priority=1.
 *   - Every alert cites at least one wiki path. An alert
 *     without a citation is unverifiable.
 */
import { z } from "zod";

export const HEARTBEAT_ALERT_SCHEMA = z
  .object({
    priority: z.number().int().min(1).max(5),
    title: z.string().min(1).max(200),
    body: z.string().min(1),
    citations: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const HEARTBEAT_OUTPUT_SCHEMA = z
  .object({
    version: z.literal("v1"),
    summary: z.string().min(1).max(500),
    alerts: z.array(HEARTBEAT_ALERT_SCHEMA).max(5),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.alerts.length > 0 && val.alerts[0]!.priority !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["alerts", 0, "priority"],
        message:
          "first alert must be priority=1 — heartbeat leads with priority-1 (architecture §9.4)",
      });
    }
  });

export type HeartbeatAlert = z.infer<typeof HEARTBEAT_ALERT_SCHEMA>;
export type HeartbeatOutput = z.infer<typeof HEARTBEAT_OUTPUT_SCHEMA>;
