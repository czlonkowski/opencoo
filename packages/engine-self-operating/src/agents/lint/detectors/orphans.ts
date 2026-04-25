/**
 * `orphans` detector — flag wiki pages that exist on disk (via
 * the McpToolClient page index) but have NO row in
 * `page_citations`. An orphan page is one of:
 *   - a manual hand-edit (legitimate, but should be cited
 *     somehow — Lint surfaces it for the operator to decide).
 *   - a leftover from a removed binding (should be deleted or
 *     re-attached).
 *   - a name collision with a removed page that still has the
 *     file on disk.
 *
 * Pure function: takes the set of wiki paths + the set of
 * cited paths + the domainSlug, returns findings.
 *
 * Special-case: `index.md` is exempt — the Index Rebuilder
 * pipeline owns it and never creates citations against it.
 * Also exempt: `worldview.md`, `log.md`, `schema.md` — the
 * Thinker / Surfacer / log writers own these per architecture
 * §3.3 / §16.2.
 */
import type { LintFinding } from "../types.js";

export interface OrphansArgs {
  readonly domainSlug: string;
  readonly wikiPaths: readonly string[];
  readonly citedPaths: ReadonlySet<string>;
}

const EXEMPT_PATHS = new Set([
  "index.md",
  "worldview.md",
  "log.md",
  "schema.md",
]);

export function detectOrphans(args: OrphansArgs): readonly LintFinding[] {
  const findings: LintFinding[] = [];
  for (const path of args.wikiPaths) {
    if (EXEMPT_PATHS.has(path)) continue;
    if (args.citedPaths.has(path)) continue;
    findings.push({
      kind: "orphans",
      severity: "low",
      scope: `${args.domainSlug}:${path}`,
      message: `${args.domainSlug}/${path} has no citation in page_citations — orphaned hand-edit, removed-binding leftover, or stale name collision`,
      detail: {
        domainSlug: args.domainSlug,
        pagePath: path,
      },
    });
  }
  return findings;
}
