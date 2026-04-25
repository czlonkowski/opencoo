/**
 * Destructive-tool deny-list (THREAT-MODEL §3.8).
 *
 * Hardcoded for v0.1 — promotion to a Postgres-backed,
 * UI-managed list is a v0.2 concern. The set is small and
 * static here so it ships in the binary and can't be
 * silently widened by a compromised admin path.
 *
 * Two layers:
 *   1. EXACT_DENY_TOOLS — full tool names that are always
 *      forbidden (e.g. `sql.execute_raw`, `wiki.delete_repo`).
 *   2. DENY_PREFIXES — namespace prefixes whose every member
 *      is forbidden (e.g. `mcp.admin.*`, `cli.deploy.*`).
 *
 * The harness checks both before dispatching any tool call. A
 * match throws `AgentDenyListError` (validation class), which
 * DLQs the run.
 */

import { AgentDenyListError } from "./errors.js";

/** Hard-deny exact tool names. */
export const EXACT_DENY_TOOLS: ReadonlySet<string> = new Set([
  "sql.execute_raw",
  "sql.drop_table",
  "wiki.delete_repo",
  "wiki.force_push",
  "fs.delete_recursive",
  "shell.exec",
  "process.kill_all",
  "secrets.dump",
]);

/** Hard-deny prefix-matched tool namespaces. The check is a
 *  literal `name.startsWith(prefix)` over the candidate; the
 *  prefix itself is also forbidden. */
export const DENY_PREFIXES: readonly string[] = [
  "mcp.admin.",
  "cli.deploy.",
];

/**
 * True iff `toolName` is on the deny-list (exact match OR
 * prefix-matched). Pure function — exported for unit testing.
 */
export function isDenied(toolName: string): boolean {
  if (EXACT_DENY_TOOLS.has(toolName)) return true;
  for (const prefix of DENY_PREFIXES) {
    if (toolName.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Throws `AgentDenyListError` if `toolName` is denied. Use
 * inside the harness's tool-dispatch path as the last gate
 * before calling the tool.
 */
export function assertToolAllowed(toolName: string): void {
  if (isDenied(toolName)) {
    throw new AgentDenyListError(toolName);
  }
}
