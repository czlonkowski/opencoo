/**
 * Strict Zod schema for the JSON the Compiler LLM returns:
 *   { merged_body: string, worldview_impact: string[] }
 *
 * `.strict()` is load-bearing — drops prompt-echo attacks
 * like {"execute_arbitrary_code":"..."}.
 */

import { z } from "zod";

export const MERGED_PAGE_BODY_SCHEMA = z
  .object({
    merged_body: z.string().min(1),
    worldview_impact: z.array(z.string()).max(20),
  })
  .strict();

export type MergedPageBodyWire = z.infer<typeof MERGED_PAGE_BODY_SCHEMA>;

/**
 * Camel-cased view returned by `mergePage` — matches the
 * classifier-output normalisation pattern so callers don't deal
 * with two casings.
 */
export interface MergedPageBody {
  readonly mergedBody: string;
  readonly worldviewImpact: readonly string[];
  readonly promptVersion: string;
}
