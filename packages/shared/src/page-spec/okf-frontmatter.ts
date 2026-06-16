/**
 * OKF v0.1 frontmatter schema (SPEC §4.1).
 *
 * `type` is the only REQUIRED field. `title`/`description`/`resource`/
 * `tags`/`timestamp` are recommended. Producers MAY add any additional
 * keys and consumers MUST preserve them when round-tripping — so this is
 * a LOOSE object: opencoo's provenance keys (`page_path`, `domain_slug`,
 * `compiled_at`, `prompt_version`, `schema_version`, `compiled_by_run_id`,
 * `source_id`, `synthesized_from`, …) validate as legal extensions rather
 * than being stripped or rejected.
 */

import { z } from "zod";

/** The OKF spec version this module targets. */
export const OKF_VERSION = "0.1";

export const okfFrontmatterSchema = z.looseObject({
  type: z.string().min(1, "OKF requires a non-empty `type` (SPEC §4.1)"),
  title: z.string().optional(),
  description: z.string().optional(),
  resource: z.string().optional(),
  tags: z.array(z.string()).optional(),
  timestamp: z.string().optional(),
});

export type OkfFrontmatter = z.infer<typeof okfFrontmatterSchema>;
