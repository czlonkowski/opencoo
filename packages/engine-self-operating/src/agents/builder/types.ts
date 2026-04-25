/**
 * Builder agent output schema (PR 21 / plan #102).
 *
 * GATE 3 SCHEMA-LEVEL DEFENSE: there is NO `activated` field
 * in this output. The agent's output schema does not have a
 * place for an activation flag because the build process does
 * not include activation. The complementary defenses are:
 *   - PROMPT (en-builder.ts) tells the LLM never to mention
 *     activation.
 *   - `AutomationAdapter` type has no `activate()` method.
 *   - Source-grep test on `builder/run.ts` for the literal
 *     `'activated'`.
 */
import { z } from "zod";

import { skillsUsedSchema } from "@opencoo/shared/db";

export const BUILDER_OUTPUT_SCHEMA = z
  .object({
    version: z.literal("v1"),
    build: z
      .object({
        candidate_id: z.string().min(1),
        template_slug: z.string().min(1),
        resolved_params: z.record(z.string(), z.unknown()),
        skills_used: skillsUsedSchema,
        rationale: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export type BuilderOutput = z.infer<typeof BUILDER_OUTPUT_SCHEMA>;
