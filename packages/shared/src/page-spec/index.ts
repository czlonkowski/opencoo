/**
 * `@opencoo/shared/page-spec` — Open Knowledge Format (OKF) v0.1 page
 * format: the frontmatter schema, reserved-filename rules, a hardened
 * frontmatter parser, and the conformance validator.
 *
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 */

export {
  OKF_VERSION,
  okfFrontmatterSchema,
  type OkfFrontmatter,
} from "./okf-frontmatter.js";
export {
  RESERVED_FILENAMES,
  type ReservedFilename,
  isReserved,
  isBundleRootIndex,
} from "./reserved.js";
export {
  parseFrontmatter,
  type ParsedFrontmatter,
} from "./parse-frontmatter.js";
export {
  validatePageConformance,
  type ConformanceViolation,
  type ConformanceResult,
  type ValidatePageInput,
} from "./validate.js";
