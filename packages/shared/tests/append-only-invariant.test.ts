import { describe, expect, it } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import {
  erasureLog,
  minerSuppressions,
  pageCitations,
  redactionEvents,
} from "../src/db/schema/index.js";

// The tables named in THREAT-MODEL §2 invariant 8 as "append-only".
// `agent_runs` is intentionally NOT in this set yet — the table lands
// in PR 04 and will be appended to this list in that PR's matching
// test extension. `catalog_candidate` is MUTATION-ADJACENT and
// explicitly excluded from this invariant.
const APPEND_ONLY_TABLES: ReadonlyArray<{ name: string; table: PgTable }> = [
  { name: "page_citations", table: pageCitations },
  { name: "redaction_events", table: redactionEvents },
  { name: "erasure_log", table: erasureLog },
  { name: "miner_suppressions", table: minerSuppressions },
];

// Any column name matching this regex is a potential mutation-timestamp
// leak, unless it's in the allow-list below.
const TIMESTAMP_RE = /_at$/;

// `created_at` is the insertion timestamp every table carries and is
// not a mutation record. Everything else ending in `_at` on an append-
// only table is a smell: those tables should not be tracking when a
// row was last touched.
const APPEND_ONLY_TIMESTAMP_ALLOW_LIST: ReadonlySet<string> = new Set([
  "created_at",
]);

describe("append-only invariant (THREAT-MODEL §2 invariant 8)", () => {
  for (const { name, table } of APPEND_ONLY_TABLES) {
    describe(name, () => {
      it("has no updated_at / modified_at / edited_at column", () => {
        const cols = getTableConfig(table).columns.map((c) => c.name);
        for (const forbidden of ["updated_at", "modified_at", "edited_at"]) {
          expect(cols).not.toContain(forbidden);
        }
      });

      it("has no other mutation-timestamp columns (anything *_at except created_at)", () => {
        const cols = getTableConfig(table).columns.map((c) => c.name);
        const offenders = cols
          .filter((c) => TIMESTAMP_RE.test(c))
          .filter((c) => !APPEND_ONLY_TIMESTAMP_ALLOW_LIST.has(c));
        expect(offenders).toEqual([]);
      });
    });
  }
});
