/**
 * `BuilderToolDescriptor` — local type the adapter exposes for
 * the agent harness to translate into MCP-compatible tool defs
 * at the composition root.
 *
 * Defined HERE rather than imported from
 * `@opencoo/engine-self-operating` so the no-cross-engine-import
 * lint rule remains correct (this package lives under
 * `packages/adapters/`). The harness adapts the shape at wiring
 * time — see `engine-self-operating/src/agents/builder/run.ts`
 * for the consumer side.
 *
 * v0.1 ships a STATIC `tools` array (open question 4). PR 38
 * promotes this to a function-with-filter shape when the
 * `n8n-mcp` runtime dep lands.
 */
export interface BuilderToolDescriptor {
  /** Unique tool identifier surfaced to the LLM. */
  readonly name: string;
  /** One-line description shown in the LLM's tool catalog. */
  readonly description: string;
  /** JSON-Schema for the tool's input. The harness validates
   *  agent calls against this schema before dispatching. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * Static set of Builder tools the agent has at v0.1. These are
 * read-only inspection tools the Builder LLM can use while
 * preparing a Proposal — they do NOT include the deployment
 * call (that goes through `AutomationAdapter.deployWorkflow`,
 * which is invoked by the harness on approved candidates only).
 *
 * Note: NO tool name contains an activation verb. The test
 * suite asserts this (Gate 3 defense-in-depth).
 */
export const tools: readonly BuilderToolDescriptor[] = [
  {
    name: "list_workflow_templates",
    description:
      "List available n8n workflow templates from the vendored n8n-skills bundle. Returns slug + one-line summary for each.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_workflow_template",
    description:
      "Fetch the full body of a single workflow template by slug. Returns the BuilderSkill JSON record.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", minLength: 1 },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
];
