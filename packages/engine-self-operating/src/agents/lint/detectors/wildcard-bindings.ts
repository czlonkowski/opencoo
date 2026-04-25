/**
 * `wildcard_bindings` detector — flag source bindings whose
 * `allowed_paths` contains only wildcard patterns (`*`, `**`,
 * `*.md`, etc.). A wildcard-only binding subverts the
 * cross-domain-write defense (THREAT-MODEL §2 invariant 1):
 * the classifier path-guard cross-checks every emitted
 * `target_pages[].path` against `allowed_paths`, so a binding
 * configured with `["**"]` admits every path the LLM emits.
 *
 * The fix is operator config, not auto-rewriting — Lint
 * surfaces the finding for review.
 *
 * Pure function: takes an array of binding rows, returns
 * findings.
 */
import type { LintFinding } from "../types.js";

export interface WildcardBindingsInput {
  readonly id: string;
  readonly domainSlug: string;
  readonly adapterSlug: string;
  readonly allowedPaths: readonly string[];
}

// A "broad" path has no narrowing path separator AND starts
// with `*` — covers `*`, `**`, `*.md`, `*.*`. A path with at
// least one `/` segment in front (e.g. `projects/*.md`,
// `team/eng.md`) is considered narrow enough that the
// classifier path-guard meaningfully bounds the LLM's reach.
function isBroad(path: string): boolean {
  return path.startsWith("*") && !path.includes("/");
}

function isWildcardOnly(paths: readonly string[]): boolean {
  if (paths.length === 0) return true;
  return paths.every(isBroad);
}

export function detectWildcardBindings(
  bindings: readonly WildcardBindingsInput[],
): readonly LintFinding[] {
  const findings: LintFinding[] = [];
  for (const b of bindings) {
    if (!isWildcardOnly(b.allowedPaths)) continue;
    findings.push({
      kind: "wildcard_bindings",
      severity: "high",
      scope: `binding:${b.id}`,
      message: `binding (${b.adapterSlug} → ${b.domainSlug}) has wildcard-only allowed_paths ${JSON.stringify(b.allowedPaths)} — narrow to specific paths to preserve the cross-domain-write defense (THREAT-MODEL §2 invariant 1)`,
      detail: {
        domainSlug: b.domainSlug,
        adapterSlug: b.adapterSlug,
        allowedPaths: [...b.allowedPaths],
      },
    });
  }
  return findings;
}
