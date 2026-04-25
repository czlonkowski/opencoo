/**
 * `stale_pages` detector — flag wiki pages whose newest
 * citation in `page_citations` is older than the staleness
 * threshold (default: 90 days). A stale page is not necessarily
 * wrong, but the absence of any recent re-compilation is a
 * signal that either (a) the source has gone quiet (worth
 * verifying with the source owner) or (b) the binding is
 * misconfigured and the source isn't reaching the page.
 *
 * Pure function: takes already-aggregated page-newest-citation
 * rows + the staleness threshold + a clock, returns findings.
 *
 * The orchestrator owns the SQL aggregation
 * (SELECT page_path, MAX(created_at) FROM page_citations …) so
 * this detector stays I/O-free.
 */
import type { LintFinding } from "../types.js";

export interface PageNewestCitation {
  readonly domainSlug: string;
  readonly pagePath: string;
  /** ISO timestamp of the newest `page_citations` row that
   *  cited this page, or null if there is no citation at all
   *  (orphan-detector territory — stale-pages skips). */
  readonly newestCitationAt: string | null;
}

export interface StalePagesArgs {
  readonly pages: readonly PageNewestCitation[];
  readonly thresholdDays: number;
  readonly now: Date;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function detectStalePages(
  args: StalePagesArgs,
): readonly LintFinding[] {
  const findings: LintFinding[] = [];
  const cutoff = args.now.getTime() - args.thresholdDays * MS_PER_DAY;
  for (const p of args.pages) {
    if (p.newestCitationAt === null) continue;
    const ts = new Date(p.newestCitationAt).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts >= cutoff) continue;
    const ageDays = Math.floor((args.now.getTime() - ts) / MS_PER_DAY);
    findings.push({
      kind: "stale_pages",
      severity: ageDays >= args.thresholdDays * 2 ? "medium" : "low",
      scope: `${p.domainSlug}:${p.pagePath}`,
      message: `${p.domainSlug}/${p.pagePath} has not been re-cited in ${ageDays} days (threshold ${args.thresholdDays}d) — verify with source owner or check binding`,
      detail: {
        domainSlug: p.domainSlug,
        pagePath: p.pagePath,
        ageDays,
        thresholdDays: args.thresholdDays,
        newestCitationAt: p.newestCitationAt,
      },
    });
  }
  return findings;
}
