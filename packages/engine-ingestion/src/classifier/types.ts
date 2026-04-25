/**
 * `ClassifierOutput` — strict Zod schema for the JSON the
 * Classifier LLM is required to emit. `.strict()` is load-bearing
 * (THREAT-MODEL §3.4 / decision Q2): any extra field the model
 * invents is rejected, which prevents prompt-echo attacks like
 * `{"execute_arbitrary_code": "..."}` from surviving validation.
 *
 * The schema is also the wire contract between the LLM and the
 * orchestrator — version field forces an explicit migration when
 * the prompt changes shape.
 */

import { z } from "zod";

export const TARGET_DOMAIN_SCHEMA = z
  .object({
    domain_slug: z.string().min(1),
    page_paths: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const CLASSIFIER_OUTPUT_SCHEMA = z
  .object({
    version: z.literal("v1"),
    language: z.enum(["en", "pl", "other"]),
    summary: z.string().min(1).max(200),
    target_domains: z.array(TARGET_DOMAIN_SCHEMA).min(1),
    pipelines: z
      .array(z.enum(["compile.single-source", "compile.roll-up"]))
      .min(1),
  })
  .strict();

export type ClassifierOutputWire = z.infer<typeof CLASSIFIER_OUTPUT_SCHEMA>;

/**
 * Camel-cased view returned by `classify()` — the orchestrator
 * normalises the snake_case wire shape so callers don't deal
 * with two casings. Wire shape stays snake_case because that's
 * what the prompt asks the model to emit (and what the model
 * is most reliable at producing).
 */
export interface ClassifierTargetDomain {
  readonly domainSlug: string;
  readonly pagePaths: readonly string[];
}

export interface ClassifierOutput {
  readonly version: "v1";
  readonly language: "en" | "pl" | "other";
  readonly summary: string;
  readonly targetDomains: readonly ClassifierTargetDomain[];
  readonly pipelines: readonly ("compile.single-source" | "compile.roll-up")[];
}
