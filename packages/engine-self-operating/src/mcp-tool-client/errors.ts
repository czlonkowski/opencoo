import { OpencooError, type OpencooErrorOptions } from "@opencoo/shared/errors";

/**
 * The requested MCP resource URI is not available — the URI is
 * not registered (production: gitea-mcp returns InvalidRequest
 * "resource not accessible"; tests: the in-memory fixture has
 * no entry for this URI). Routed as `validation` so the run
 * DLQs — a missing resource is a config bug, not a transient
 * fault.
 */
export class McpResourceNotFoundError extends OpencooError {
  readonly uri: string;

  constructor(uri: string, options?: OpencooErrorOptions) {
    super(
      `mcp-tool-client: resource '${uri}' not found`,
      "validation",
      options,
    );
    this.name = "McpResourceNotFoundError";
    this.uri = uri;
  }
}
