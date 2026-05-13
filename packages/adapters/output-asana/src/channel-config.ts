/**
 * Asana channel-config schema (PR-Z4, phase-a appendix #12 G5;
 * extended in PR-W5, phase-a appendix #14).
 *
 * Operators provision an `output_channels` row per logical
 * "destination" (e.g. "Daily report → daily-ops project").
 * The config is the operator's per-channel knobs — `project_gid`
 * (required) + optional Asana wiring.
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
 *
 * PR-W5 (phase-a appendix #14) — added `assignee_gid` (already
 * existed), `section_gid`, `due_date_policy`, and `title_prefix`
 * so the heartbeat → Asana task matches the n8n-baseline shape:
 *   - `[COO] Raport -- YYYY-MM-DD` title shape (operator-settable
 *     `title_prefix`).
 *   - `due_on = today` so the task lands in the operator's
 *     "Today" bucket.
 *   - Tasks land in a specific Asana section via `memberships`
 *     when `section_gid` is set.
 *   - Default assignee via `assignee_gid` (unchanged shape,
 *     pre-existing).
 *
 * All fields are optional EXCEPT `project_gid`. `due_date_policy`
 * defaults to `"today"` and `title_prefix` defaults to
 * `"[COO] Raport -- "` when the operator omits the key.
 */
import { z } from "zod";

/** Default channel-config values applied at parse time when the
 *  operator omits the field. Exported so callers (the transformer)
 *  can mirror the same defaults when the channel config is missing
 *  the keys entirely (e.g. legacy rows persisted before this PR). */
export const ASANA_CHANNEL_CONFIG_DEFAULTS = {
  /** Default due-date policy — heartbeat task lands as "Today" so
   *  the operator's task list shows it in the "Dzisiaj" / today
   *  bucket. n8n baseline always set this. */
  due_date_policy: "today",
  /** Default title prefix — matches the n8n pilot's
   *  `[COO] Raport -- YYYY-MM-DD` shape. The transformer appends
   *  today's ISO date to this prefix. Operators can override (e.g.
   *  to `"opencoo daily — "` or empty-string to fall back to the
   *  date-then-summary shape). */
  title_prefix: "[COO] Raport -- ",
} as const;

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
    section_gid: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional Asana section gid; when set the task lands in that " +
          "section via the `memberships` field (Asana resolves the " +
          "workspace from the project).",
      ),
    due_date_policy: z
      .enum(["today", "none"])
      .optional()
      .default(ASANA_CHANNEL_CONFIG_DEFAULTS.due_date_policy)
      .describe(
        "Heartbeat task due-date policy. `today` sets `due_on` to " +
          "the current ISO date so the task shows in the 'today' " +
          "bucket; `none` omits the field. Defaults to `today`.",
      ),
    title_prefix: z
      .string()
      .max(200)
      .optional()
      .default(ASANA_CHANNEL_CONFIG_DEFAULTS.title_prefix)
      .describe(
        "Heartbeat task title prefix. The transformer appends " +
          "today's ISO date to this prefix (e.g. '[COO] Raport -- " +
          "2026-05-13'). Empty string falls back to '<date> — " +
          "<summary first 100 chars>'. Defaults to '[COO] Raport -- '.",
      ),
  })
  .strict();

export type AsanaChannelConfig = z.infer<typeof asanaChannelConfigSchema>;

/** UI-renderable JSON-Schema-shape for the operator's form. The
 *  Management UI's `NewOutputChannelModal` renders this verbatim —
 *  `string`-typed entries become `<input type="text">` widgets;
 *  the `due_date_policy` field is a free-text input (the server-side
 *  Zod schema enforces the enum on submit). */
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
    section_gid: {
      type: "string" as const,
      description:
        "Optional Asana section gid; when set the task lands in that section.",
    },
    due_date_policy: {
      type: "string" as const,
      description:
        "Heartbeat task due-date policy: 'today' or 'none'. Defaults to 'today'.",
    },
    title_prefix: {
      type: "string" as const,
      description:
        "Heartbeat task title prefix. Defaults to '[COO] Raport -- '. Empty string falls back to '<date> — <summary>'.",
    },
  },
  required: ["project_gid"] as const,
};
