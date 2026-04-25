import type { TSESTree } from "@typescript-eslint/utils";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";

import { createRule } from "../utils/create-rule.js";

/**
 * Hard-coded list of Drizzle symbol names for append-only tables —
 * those that must never be targeted by `db.update(...)` or
 * `db.delete(...)`. Matches the §2 invariant 8 set in THREAT-MODEL.md
 * and the iteration list in
 * `packages/shared/tests/append-only-invariant.test.ts`.
 *
 * `agentRuns` is in this set. The §2 invariant 8 carve-out
 * (PR 19 / plan #87 Q11) is implemented as an INLINE
 * `// eslint-disable-next-line opencoo/no-update-append-only`
 * at the SOLE sanctioned call site — `recorder.completeRun()`
 * — which terminalizes `status` from 'running' to a terminal
 * value via a guarded UPDATE (`WHERE status = 'running'`).
 * Keeping the table in the set means any other code path that
 * tries to UPDATE/DELETE `agent_runs` lints red and the
 * carve-out remains visible at exactly one location.
 *
 * When you add a new append-only table, append its Drizzle symbol
 * name here. The set is intentionally hard-coded for v0.1; migrate to
 * schema metadata (derive from a manifest export in @opencoo/shared)
 * if the set grows beyond ~10 entries.
 */
const APPEND_ONLY_TABLES = new Set([
  "agentRuns",
  "pageCitations",
  "redactionEvents",
  "erasureLog",
  "minerSuppressions",
  "llmUsageDebug",
  // PR 28 / plan #128 — admin-API audit log. Append-only per
  // THREAT-MODEL §2 invariant 8 + §3.13. The writer in
  // `engine-self-operating/src/admin-api/audit-log.ts` only
  // INSERTs; any future code path that tries to UPDATE/DELETE
  // it lints red here.
  "adminAuditLog",
]);

type MessageIds = "updateAppendOnly" | "deleteAppendOnly";

function firstArgIdentifierName(
  call: TSESTree.CallExpression,
): string | null {
  const arg = call.arguments[0];
  if (arg === undefined) return null;
  if (arg.type !== AST_NODE_TYPES.Identifier) return null;
  return arg.name;
}

export const noUpdateAppendOnly = createRule<[], MessageIds>({
  name: "no-update-append-only",
  meta: {
    type: "problem",
    docs: {
      description:
        "Append-only tables (THREAT-MODEL.md §2 invariant 8) must not be UPDATEd or DELETEd by engine code — only INSERTed, and only pruned by Cleanup.",
    },
    schema: [],
    messages: {
      updateAppendOnly:
        "`db.update({{table}})` is forbidden — {{table}} is append-only per THREAT-MODEL §2 invariant 8. Insert a new row or adjust the schema carve-out.",
      deleteAppendOnly:
        "`db.delete({{table}})` is forbidden — {{table}} is append-only per THREAT-MODEL §2 invariant 8. Retention pruning is the only sanctioned delete path and lives in the Cleanup pipeline.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node): void {
        // Matches both `db.update(tbl)` and chain forms like
        // `db.with(cte).update(tbl)` — the walker fires on the
        // innermost CallExpression whose method name matches, not on
        // the chain head. No special-casing needed.
        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) return;
        if (node.callee.property.type !== AST_NODE_TYPES.Identifier) return;

        const method = node.callee.property.name;
        if (method !== "update" && method !== "delete") return;

        const tableName = firstArgIdentifierName(node);
        if (tableName === null) return;
        if (!APPEND_ONLY_TABLES.has(tableName)) return;

        context.report({
          node,
          messageId:
            method === "update" ? "updateAppendOnly" : "deleteAppendOnly",
          data: { table: tableName },
        });
      },
    };
  },
});
