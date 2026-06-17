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

// OKF §4.1: `timestamp` is an ISO 8601 datetime. Accept both the `Z`
// (UTC) and `±HH:MM` offset forms — the reference bundles use offsets,
// opencoo emits `Z`. A precise regex avoids zod-version API drift and
// rejects clearly-non-datetime values.
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const okfFrontmatterSchema = z.looseObject({
  // `.trim().min(1)` rejects a whitespace-only type, matching
  // validatePageConformance's trim semantics (a producer that emits
  // `type: "   "` would otherwise pass the schema but fail the gate).
  type: z.string().trim().min(1, "OKF requires a non-empty `type` (SPEC §4.1)"),
  title: z.string().optional(),
  description: z.string().optional(),
  resource: z.string().optional(),
  tags: z.array(z.string()).optional(),
  timestamp: z
    .string()
    .regex(
      ISO_DATETIME_RE,
      "OKF `timestamp` must be an ISO 8601 datetime (SPEC §4.1)",
    )
    .optional(),
});

export type OkfFrontmatter = z.infer<typeof okfFrontmatterSchema>;
