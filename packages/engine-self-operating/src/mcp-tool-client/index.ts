/**
 * Public surface for the McpToolClient subsystem (PR 20, plan
 * #92 part A). v0.1 ships only the port + an in-memory test
 * fixture; production `HttpMcpToolClient` arrives in PR 23+.
 */

export { McpResourceNotFoundError } from "./errors.js";
export {
  type McpListFilter,
  type McpToolClient,
} from "./interface.js";
export { InMemoryMcpToolClient } from "./in-memory.js";
