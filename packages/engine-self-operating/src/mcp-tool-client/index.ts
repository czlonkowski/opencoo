/**
 * Public surface for the McpToolClient subsystem (PR 20, plan
 * #92 part A; PR-N3 phase-a appendix #6 adds the HTTP transport).
 *
 * v0.1 ships:
 *   - the port shape (interface),
 *   - an in-memory test fixture (used by every agent unit test),
 *   - the static-bearer HTTP transport (used in production by the
 *     CLI's `serve` verb),
 *   - the PAT-scoped wrapper (deferred to phase-b Chat agent).
 */

export {
  McpHttpError,
  McpResourceNotFoundError,
  type McpHttpErrorOptions,
} from "./errors.js";
export {
  type McpListFilter,
  type McpToolClient,
} from "./interface.js";
export { InMemoryMcpToolClient } from "./in-memory.js";
export {
  HttpMcpToolClient,
  type HttpMcpToolClientOptions,
} from "./http.js";
export {
  createPatScopedMcpClient,
  type PatScopedAuditEntry,
  type PatScopedMcpToolClient,
} from "./pat-scope.js";
