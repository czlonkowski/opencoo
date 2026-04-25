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

function yamlQuoteIfNeeded(value: string): string {
  if (value === "") return '""';
  if (!YAML_SPECIAL_RE.test(value) && !/^\s|\s$/.test(value)) {
    return value;
  }
  // Double-quoted string with backslash-escaped embedded quotes.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export interface BuildFrontmatterArgs {
  readonly title: string;
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
  const lines = [
    "---",
    `title: ${yamlQuoteIfNeeded(args.title)}`,
    `page_path: ${args.pagePath}`,
    `domain_slug: ${args.domainSlug}`,
    `compiled_at: ${args.compiledAt.toISOString()}`,
    `prompt_version: ${args.promptVersion}`,
    `schema_version: ${SCHEMA_VERSION}`,
    "---",
  ];
  return lines.join("\n") + "\n";
}
