/**
 * Builder agent definition (architecture §7.2.4 / plan #102).
 * Picks up an approved automation_candidate, materialises the
 * proposal as an n8n workflow at status='deployed' (NOT
 * activated), records the deployment row.
 *
 * `defaultMemory: 'none'` — Builder is single-shot per
 * candidate.
 */
import type { AgentDefinition } from "../../agent-harness/index.js";

export const BUILDER_DEFINITION: AgentDefinition = {
  slug: "builder",
  version: "1.0.0",
  description:
    "Materialises approved automation candidates as deployed n8n workflows. NEVER activates (Gate 3, manual operator step in n8n).",
  outputSchemaName: "BuilderOutput",
  defaultMemory: { type: "none" },
  // Read-only tool surface for the same reason every other v0.1
  // agent has one — the automation_drift Lint detector flags
  // any past tool_calls[].name not in this set. The Builder's
  // deploy side-effect goes through `AutomationAdapter`, NOT a
  // ctx.callTool — the adapter has no activation method
  // (Gate 3) and is not exposed as an LLM-callable tool.
  toolNames: ["worldview.read"],
};
