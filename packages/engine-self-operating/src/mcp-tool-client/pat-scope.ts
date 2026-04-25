/**
 * `createPatScopedMcpClient` — wrap any base McpToolClient with
 * a per-call gitea PAT (plan #97 Q4-Q5).
 *
 * Design: WRAPPER, not port extension. The base
 * (InMemoryMcpToolClient in tests, HttpMcpToolClient in PR 23+
 * production) stays PAT-agnostic. The wrapper carries the PAT
 * and is the seam where production wires header injection.
 *
 * Reader agents (Heartbeat, Lint) never call this — they have
 * no callerPat and run on a schedule with no human caller. Only
 * the Chat agent (which receives a callerPat from the engine
 * HTTP handler) invokes the wrapper.
 *
 * In production, the wrapper would inject
 * `Authorization: Bearer <callerPat>` on each MCP request and
 * the gitea-wiki-mcp-server would enforce the PAT's repo scope.
 * v0.1 ships only the wrapper shape + an audit log so tests can
 * assert PAT propagation.
 */
import type {
  McpListFilter,
  McpToolClient,
} from "./interface.js";

/** Per-call audit-log entry. Production ignores this; tests
 *  use it to verify the PAT was attached on every call. */
export type PatScopedAuditEntry =
  | {
      readonly kind: "readResource";
      readonly uri: string;
      readonly callerPat: string;
    }
  | {
      readonly kind: "listResources";
      readonly filter: McpListFilter | undefined;
      readonly callerPat: string;
    };

export interface PatScopedMcpToolClient extends McpToolClient {
  /** The gitea PAT this wrapper carries. Production
   *  HttpMcpToolClient reads this on each call to inject the
   *  Authorization header. */
  readonly callerPat: string;
  /** Per-call audit log. Tests use this to verify the PAT was
   *  attached. Production code reads `callerPat` directly and
   *  ignores the log. */
  readonly auditLog: readonly PatScopedAuditEntry[];
}

export function createPatScopedMcpClient(
  base: McpToolClient,
  callerPat: string,
): PatScopedMcpToolClient {
  // Internal mutable backing array. The public `auditLog`
  // getter returns a shallow copy so callers cannot push into
  // the wrapper's state via `as unknown as`-style escape
  // hatches (copilot #23 fix 1).
  const auditLog: PatScopedAuditEntry[] = [];
  return {
    callerPat,
    get auditLog(): readonly PatScopedAuditEntry[] {
      return [...auditLog];
    },
    async readResource(uri: string): Promise<string> {
      auditLog.push({ kind: "readResource", uri, callerPat });
      return base.readResource(uri);
    },
    async listResources(
      filter?: McpListFilter,
    ): Promise<readonly string[]> {
      auditLog.push({ kind: "listResources", filter, callerPat });
      return base.listResources(filter);
    },
  };
}
