/**
 * Asana channel-config schema (PR-Z4, phase-a appendix #12 G5).
 *
 * Operators provision an `output_channels` row per logical
 * "destination" (e.g. "Daily report → Estyl daily-ops project").
 * The config is the operator's per-channel knobs — `project_gid`
 * (required) + optional `assignee_gid`.
 *
 * The agent's emitted payload (title + notes) is filled in by the
 * dispatcher's `mergePayload` closure at delivery time — NOT here.
 * Keeping the two schemas separate (channel config vs adapter
 * payload) lets the UI render an "Outputs" form for the operator
 * without exposing the agent-internal payload shape.
 *
 * The schema deliberately mirrors the source-adapter's
 * `bindingConfigSchema` shape so the UI's existing
 * schema-driven form renderer (architecture §10 + ARCHITECTURE.md)
 * works without per-adapter UI changes.
 */
import { z } from "zod";

/** Zod schema the route uses for validate-on-write. */
export const asanaChannelConfigSchema = z
  .object({
    project_gid: z
      .string()
      .min(1)
      .describe("Asana project gid the heartbeat task lands in."),
    assignee_gid: z
      .string()
      .min(1)
      .optional()
      .describe("Optional Asana user gid to auto-assign the task to."),
  })
  .strict();

export type AsanaChannelConfig = z.infer<typeof asanaChannelConfigSchema>;

/** UI-renderable JSON-Schema-shape for the operator's form. */
export const asanaChannelConfigJsonSchema = {
  type: "object" as const,
  properties: {
    project_gid: {
      type: "string" as const,
      description: "Asana project gid (number string) tasks land in.",
    },
    assignee_gid: {
      type: "string" as const,
      description: "Optional Asana user gid to auto-assign.",
    },
  },
  required: ["project_gid"] as const,
};
