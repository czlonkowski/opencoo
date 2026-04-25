/**
 * Asana task payload schema (PR 24 / plan #115).
 *
 * The schema is `.strict()` per the OutputAdapter contract
 * suite assertion 8 — over-keyed payloads fail Zod-parse
 * BEFORE any external call. Defense-in-depth against agent
 * field-smuggling.
 */
import { z } from "zod";

export const asanaTaskPayloadSchema = z
  .object({
    /** Task title — required, single-line. */
    title: z.string().min(1).max(500),
    /** Notes / description — optional but most callers
     *  populate. The Asana API accepts up to 65,535 chars; we
     *  cap at 32 KB to keep prompt-side payloads bounded. */
    notes: z.string().max(32_768),
    /** Project gid the task lands in. */
    projectGid: z.string().min(1),
    /** Optional ISO-date string `YYYY-MM-DD`. Asana's
     *  `due_on` field. */
    dueOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "due_on must be YYYY-MM-DD")
      .optional(),
    /** Optional Asana user gid for assignment. */
    assigneeGid: z.string().min(1).optional(),
  })
  .strict();

export type AsanaTaskPayload = z.infer<typeof asanaTaskPayloadSchema>;
