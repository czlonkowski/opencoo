/**
 * Review Dashboard — lint findings (PR 28 / plan #128, item
 * type 2 of THREAT-MODEL §7.3).
 *
 * Per planner Q6: there is NO `lint_findings` table. Findings
 * live in `agent_runs.output` jsonb on Lint runs (definition_slug
 * = 'lint'). The route reads the most recent succeeded Lint run
 * per domain and unpacks its `output.findings` array.
 *
 * Read-only at v0.1 — acknowledgement (audit-action
 * `lint_finding.acknowledge`) is wired in a follow-up PR but
 * the action allowlist already includes the verb so the writer
 * is forward-compatible.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface LintFinding {
  readonly kind: string;
  readonly path: string;
  readonly detail: string;
}

export interface RegisterLintFindingsRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerLintFindingsRoutes(
  args: RegisterLintFindingsRoutesArgs,
): void {
  args.app.get("/api/admin/lint-findings", async () => {
    // Pull the latest succeeded Lint run per agent_instance.
    // The detector orchestrator (PR 20A) writes one row per
    // Lint cycle; we surface the latest one's findings.
    const result = (await args.db.execute(sql`
      SELECT id::text AS id,
             instance_id::text AS instance_id,
             output,
             ended_at
      FROM agent_runs
      WHERE definition_slug = 'lint'
        AND status = 'success'
        AND output IS NOT NULL
      ORDER BY ended_at DESC NULLS LAST
      LIMIT 50
    `)) as unknown as {
      rows: Array<{
        id: string;
        instance_id: string | null;
        output: { findings?: unknown } | null;
        ended_at: Date | string | null;
      }>;
    };

    const out: Array<{
      readonly runId: string;
      readonly instanceId: string | null;
      readonly endedAt: string | null;
      readonly findings: readonly LintFinding[];
    }> = [];
    for (const r of result.rows) {
      const findings: LintFinding[] = [];
      const rawFindings = r.output?.findings;
      if (Array.isArray(rawFindings)) {
        for (const f of rawFindings) {
          if (
            typeof f === "object" &&
            f !== null &&
            typeof (f as { kind?: unknown }).kind === "string" &&
            typeof (f as { path?: unknown }).path === "string" &&
            typeof (f as { detail?: unknown }).detail === "string"
          ) {
            findings.push({
              kind: (f as { kind: string }).kind,
              path: (f as { path: string }).path,
              detail: (f as { detail: string }).detail,
            });
          }
        }
      }
      out.push({
        runId: r.id,
        instanceId: r.instance_id,
        endedAt:
          r.ended_at === null
            ? null
            : r.ended_at instanceof Date
              ? r.ended_at.toISOString()
              : new Date(r.ended_at).toISOString(),
        findings,
      });
    }
    return { runs: out };
  });
}
