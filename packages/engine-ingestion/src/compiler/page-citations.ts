/**
 * `recordPageCitations` — append-only writer for the
 * `page_citations` table. Called by the compiler AFTER a
 * successful wikiWrite commit.
 *
 * Per planner Q8: a soft failure here logs+alerts but does NOT
 * unwind the wiki commit. The page is already in the wiki repo;
 * a missing citation row is a reconciliation problem (future PR
 * adds a backfill scan), not grounds to roll back the commit.
 */

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { pageCitations } from "@opencoo/shared/db/schema";
import type { AgentRunId, SourceBindingId } from "@opencoo/shared/db";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RecordPageCitationsArgs {
  readonly db: Db;
  readonly domainSlug: string;
  readonly pagePaths: readonly string[];
  readonly sourceBindingId: SourceBindingId;
  readonly sourceRef: string;
  readonly promptVersion: string;
  readonly compiledByRunId?: AgentRunId;
}

export async function recordPageCitations(
  args: RecordPageCitationsArgs,
): Promise<void> {
  if (args.pagePaths.length === 0) return;
  const rows = args.pagePaths.map((pagePath) => ({
    domainSlug: args.domainSlug,
    pagePath,
    sourceBindingId: args.sourceBindingId,
    sourceRef: args.sourceRef,
    promptVersion: args.promptVersion,
    compiledByRunId: args.compiledByRunId ?? null,
  }));
  await args.db.insert(pageCitations).values(rows);
}
