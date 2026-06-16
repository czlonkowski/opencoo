/**
 * `buildFrontmatter` — synthesises the YAML frontmatter block
 * the compiler prepends to every page body. Pure function; no
 * I/O, no LLM, no DB.
 *
 * Schema is fixed per planner Q5: title, page_path, domain_slug,
 * compiled_at (ISO-8601), prompt_version, schema_version. The
 * schema_version is hardcoded `1.0.0` here; promote to
 * `@opencoo/shared/page-spec` when Lint/Heartbeat (PR 17+) also
 * need to read it.
 *
 * Strings that contain YAML-significant characters are quoted +
 * escaped. We always quote when in doubt — quoting a plain
 * string is harmless; failing to quote a colon-bearing string
 * produces invalid YAML the lint stage would reject.
 */

import { CompilerValidationError } from "./errors.js";

const SCHEMA_VERSION = "1.0.0";

// Match characters whose presence in a YAML scalar value REQUIRES
// quoting under YAML 1.2. A leading `[` or `{` would parse as a
// flow collection; `:` followed by space starts a mapping;
// `&`/`*`/`!`/`|`/`>` are reserved indicators.
const YAML_SPECIAL_RE = /[:&*!|>'"#%@`{}[\],?]/;

// Patterns that match YAML 1.2 IMPLICIT TYPE coercions — without
// quoting, downstream parsers (js-yaml, gray-matter) read these as
// non-strings (number, bool, null, date), breaking any consumer
// that expects the field to stay a string. Always quote when any
// of these match. (copilot #18)
const YAML_NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const YAML_BOOL_NULL_RE = /^(true|false|yes|no|on|off|null|~)$/i;
const YAML_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function yamlQuoteIfNeeded(value: string): string {
  if (value === "") return '""';
  const needsQuoting =
    YAML_SPECIAL_RE.test(value) ||
    /^\s|\s$/.test(value) ||
    YAML_NUMERIC_RE.test(value) ||
    YAML_BOOL_NULL_RE.test(value) ||
    YAML_DATE_RE.test(value);
  if (!needsQuoting) return value;
  // Double-quoted string with backslash-escaped embedded quotes.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export interface BuildFrontmatterArgs {
  readonly title: string;
  /**
   * OKF v0.1 `type` — the concept kind (SPEC §4.1, the only required
   * frontmatter field). For the document compiler this is always
   * "Knowledge Page"; other producers (catalog templates) pass their
   * own. Must be non-empty.
   */
  readonly type: string;
  readonly pagePath: string;
  readonly domainSlug: string;
  readonly compiledAt: Date;
  readonly promptVersion: string;
}

export function buildFrontmatter(args: BuildFrontmatterArgs): string {
  if (args.title.length === 0) {
    throw new CompilerValidationError(
      "buildFrontmatter: title must not be empty",
    );
  }
  if (/[\n\r]/.test(args.title)) {
    throw new CompilerValidationError(
      "buildFrontmatter: title must not contain newline or carriage return",
    );
  }
  if (args.type.length === 0) {
    throw new CompilerValidationError(
      "buildFrontmatter: type must not be empty (OKF §4.1 requires a non-empty type)",
    );
  }
  if (/[\n\r]/.test(args.type)) {
    throw new CompilerValidationError(
      "buildFrontmatter: type must not contain newline or carriage return",
    );
  }
  // Every scalar value runs through yamlQuoteIfNeeded — defense in
  // depth so a future field whose value happens to be "1.0" or
  // "true" doesn't silently become a number/bool downstream.
  // (copilot #18, advisory broader fix)
  const compiledAtIso = args.compiledAt.toISOString();
  const lines = [
    "---",
    `title: ${yamlQuoteIfNeeded(args.title)}`,
    `type: ${yamlQuoteIfNeeded(args.type)}`,
    `page_path: ${yamlQuoteIfNeeded(args.pagePath)}`,
    `domain_slug: ${yamlQuoteIfNeeded(args.domainSlug)}`,
    `compiled_at: ${yamlQuoteIfNeeded(compiledAtIso)}`,
    // OKF v0.1 recommended `timestamp` (SPEC §4.1): last meaningful
    // change. Mirrors compiled_at; `compiled_at` stays as the opencoo
    // provenance extension key.
    `timestamp: ${yamlQuoteIfNeeded(compiledAtIso)}`,
    `prompt_version: ${yamlQuoteIfNeeded(args.promptVersion)}`,
    `schema_version: ${yamlQuoteIfNeeded(SCHEMA_VERSION)}`,
    "---",
  ];
  return lines.join("\n") + "\n";
}
