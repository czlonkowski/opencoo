/**
 * OKF v0.1 conformance validator (SPEC §9).
 *
 * A page is conformant when:
 *   1. (non-reserved `.md`) it has a parseable YAML frontmatter block,
 *   2. (non-reserved `.md`) that block has a non-empty `type`,
 *   3. (reserved `index.md` / `log.md`) it follows §6 / §7 structure.
 *
 * Everything else is soft guidance — per §9 the validator is permissive:
 * it does NOT flag unknown `type` values, unknown extra keys, missing
 * optional fields, or broken cross-links. This is the producer gate that
 * `wiki-write` runs and the lens `source-okf` applies to imported bundles.
 */

import { isBundleRootIndex, isReserved } from "./reserved.js";
import { parseFrontmatter } from "./parse-frontmatter.js";

export interface ConformanceViolation {
  /** Stable machine-readable code (e.g. "missing-type"). */
  readonly rule: string;
  /** Human-readable explanation, prefixed with the page path. */
  readonly message: string;
}

export interface ConformanceResult {
  readonly conformant: boolean;
  readonly violations: readonly ConformanceViolation[];
}

export interface ValidatePageInput {
  /** Repo-relative page path (e.g. "strategy/q3.md", "index.md"). */
  readonly path: string;
  /** Full page content including any frontmatter. */
  readonly content: string;
}

// An H2 heading line. `## ` followed by a non-space. Excludes H1/H3+.
const H2_RE = /^##\s+\S/;
// An H2 heading that is exactly an ISO 8601 calendar date.
const ISO_DATE_HEADING_RE = /^##\s+\d{4}-\d{2}-\d{2}\s*$/;

export function validatePageConformance(
  input: ValidatePageInput,
): ConformanceResult {
  const violations: ConformanceViolation[] = [];

  if (!isReserved(input.path)) {
    validateConcept(input, violations);
  } else if (basenameIsIndex(input.path)) {
    validateIndex(input, violations);
  } else {
    validateLog(input, violations);
  }

  return { conformant: violations.length === 0, violations };
}

function basenameIsIndex(pagePath: string): boolean {
  const base = pagePath.replace(/^\//, "").split("/").pop();
  return base === "index.md";
}

function validateConcept(
  input: ValidatePageInput,
  out: ConformanceViolation[],
): void {
  const fm = parseFrontmatter(input.content);
  if (!fm.present) {
    out.push({
      rule: "missing-frontmatter",
      message: `${input.path}: non-reserved page has no YAML frontmatter (OKF §9.1)`,
    });
    return;
  }
  if (!fm.parseable) {
    out.push({
      rule: "unparseable-frontmatter",
      message: `${input.path}: frontmatter is not parseable YAML (OKF §9.1)`,
    });
    return;
  }
  const type = fm.data["type"];
  if (typeof type !== "string" || type.trim().length === 0) {
    out.push({
      rule: "missing-type",
      message: `${input.path}: frontmatter must contain a non-empty \`type\` (OKF §4.1/§9.2)`,
    });
  }
}

function validateIndex(
  input: ValidatePageInput,
  out: ConformanceViolation[],
): void {
  const fm = parseFrontmatter(input.content);
  // No frontmatter is the norm for index.md (SPEC §6).
  if (!fm.present) return;
  if (!fm.parseable) {
    out.push({
      rule: "unparseable-frontmatter",
      message: `${input.path}: index.md frontmatter is not parseable YAML (OKF §6)`,
    });
    return;
  }
  const keys = Object.keys(fm.data);
  if (!isBundleRootIndex(input.path)) {
    if (keys.length > 0) {
      out.push({
        rule: "index-has-frontmatter",
        message: `${input.path}: only the bundle-root index.md may carry frontmatter (OKF §6/§11)`,
      });
    }
    return;
  }
  // Bundle-root index.md: only `okf_version` is permitted (SPEC §11).
  const extra = keys.filter((k) => k !== "okf_version");
  if (extra.length > 0) {
    out.push({
      rule: "index-frontmatter-not-okf-version",
      message: `${input.path}: root index.md frontmatter may only declare \`okf_version\` (OKF §11); found extra: ${extra.join(", ")}`,
    });
  }
}

function validateLog(
  input: ValidatePageInput,
  out: ConformanceViolation[],
): void {
  for (const line of input.content.split(/\r?\n/)) {
    if (H2_RE.test(line) && !ISO_DATE_HEADING_RE.test(line)) {
      out.push({
        rule: "log-bad-date-heading",
        message: `${input.path}: log.md H2 headings must be ISO dates \`## YYYY-MM-DD\` (OKF §7); offending: ${line.trim()}`,
      });
    }
  }
}
