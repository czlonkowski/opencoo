/**
 * `automation_drift` detector — flag past tool calls whose
 * `name` is NOT in the matching agent definition's
 * `toolNames` set. Surfaces evidence of a tool slipped in
 * without being declared (e.g. a Builder-skill autoupdate
 * landed a new write tool, but the AgentDefinition wasn't
 * bumped to declare it).
 *
 * Pure function over flat observations + a definition→
 * allowed-tools map. The orchestrator owns the SQL aggregation
 * (a 30-day window with status='success') and feeds the
 * detector already-loaded ToolCallObservation rows.
 *
 * Per Q6 (architecture / plan #97): the orchestrator's SQL
 * is the bound on cost — the detector is O(N) in observations
 * and trusts the input set.
 *
 * Skips observations whose definition slug is not in the map
 * — registry drift (an agent that was registered, then
 * unregistered) is logged separately by the orchestrator,
 * not surfaced as a per-call drift finding.
 */
import type { LintFinding } from "../types.js";

export interface ToolCallObservation {
  readonly definitionSlug: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly name: string;
}

export interface AutomationDriftArgs {
  readonly observations: readonly ToolCallObservation[];
  readonly allowedToolsBySlug: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
}

export function detectAutomationDrift(
  args: AutomationDriftArgs,
): readonly LintFinding[] {
  const findings: LintFinding[] = [];
  for (const o of args.observations) {
    const allowed = args.allowedToolsBySlug.get(o.definitionSlug);
    if (allowed === undefined) continue; // registry drift, not call drift
    if (allowed.has(o.name)) continue;
    findings.push({
      kind: "automation_drift",
      severity: "medium",
      scope: `${o.definitionSlug}:${o.runId}`,
      message: `agent '${o.definitionSlug}' invoked tool '${o.name}' in run ${o.runId} (${o.startedAt}) — not in the definition's allowed toolNames; declare it on the definition or remove the call site`,
      detail: {
        definitionSlug: o.definitionSlug,
        runId: o.runId,
        startedAt: o.startedAt,
        toolName: o.name,
      },
    });
  }
  return findings;
}
