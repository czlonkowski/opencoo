/**
 * `prompt_version_drift` detector — flag wiki pages whose
 * NEWEST `page_citations.prompt_version` lags the loader's
 * current version for that prompt name. The compiler stamps
 * `prompt_version` into every page_citation; when the prompt
 * is bumped (en/pl in lockstep — see prompts/loader.ts), the
 * old pages are still on disk but were compiled against a
 * stale prompt.
 *
 * Recompile is the operator's call (it's not free). Lint just
 * surfaces the lag.
 *
 * Pure function: takes per-page newest-version aggregations +
 * the canonical map of {promptName → currentVersion} + the
 * domain slug, returns findings.
 */
import type { LintFinding } from "../types.js";

export interface PageNewestPromptVersion {
  readonly domainSlug: string;
  readonly pagePath: string;
  /** The compiler stamps this — it is the loader's
   *  `version` from when the page was last compiled. Null
   *  means the page predates the prompt-version stamp (or
   *  was hand-edited and has no citation). Skip nulls;
   *  orphans-detector handles the no-citation case. */
  readonly newestPromptVersion: string | null;
  /** Logical prompt that produced this page — `compiler` for
   *  v0.1 (the only prompt that writes pages today). The
   *  detector cross-checks against `currentVersions[promptName]`. */
  readonly promptName: string;
}

export interface PromptVersionDriftArgs {
  readonly pages: readonly PageNewestPromptVersion[];
  readonly currentVersions: Readonly<Record<string, string>>;
}

export function detectPromptVersionDrift(
  args: PromptVersionDriftArgs,
): readonly LintFinding[] {
  const findings: LintFinding[] = [];
  for (const p of args.pages) {
    if (p.newestPromptVersion === null) continue;
    const current = args.currentVersions[p.promptName];
    if (current === undefined) continue;
    if (p.newestPromptVersion === current) continue;
    findings.push({
      kind: "prompt_version_drift",
      severity: "low",
      scope: `${p.domainSlug}:${p.pagePath}`,
      message: `${p.domainSlug}/${p.pagePath} was last compiled against ${p.promptName}@${p.newestPromptVersion} but the current loader version is ${current} — recompile to refresh`,
      detail: {
        domainSlug: p.domainSlug,
        pagePath: p.pagePath,
        promptName: p.promptName,
        compiledVersion: p.newestPromptVersion,
        currentVersion: current,
      },
    });
  }
  return findings;
}
