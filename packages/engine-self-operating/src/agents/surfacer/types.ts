/**
 * Surfacer agent output schema (PR 21 / plan #102). The LLM
 * returns this exact shape via `router.generateObject`;
 * Zod-strict parses fail-closed as
 * `LlmProviderError(validation)` → DLQ.
 *
 * Cap candidates at 10 per run (prompt + schema agree).
 * Every candidate cites at least one wiki page.
 */
import { z } from "zod";

import { pageRefSchema, proposalSchema } from "@opencoo/shared/db";

export const SURFACER_CANDIDATE_SCHEMA = z
  .object({
    title: z.string().min(1).max(80),
    summary: z.string().min(1).max(500),
    template_slug: z.string().min(1),
    params: z.record(z.string(), z.unknown()),
    source_page_refs: z.array(pageRefSchema).min(1),
    rationale: z.string().min(1).optional(),
  })
  .strict();

export const SURFACER_OUTPUT_SCHEMA = z
  .object({
    version: z.literal("v1"),
    candidates: z.array(SURFACER_CANDIDATE_SCHEMA).max(10),
  })
  .strict();

export type SurfacerCandidate = z.infer<typeof SURFACER_CANDIDATE_SCHEMA>;
export type SurfacerOutput = z.infer<typeof SURFACER_OUTPUT_SCHEMA>;

// Re-export the underlying schemas for completeness.
export { pageRefSchema, proposalSchema };
