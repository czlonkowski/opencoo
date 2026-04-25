/**
 * Chat agent definition (PR 20 part B / plan #97). Read-only;
 * the engine HTTP handler invokes this on every user question
 * with the user's gitea PAT in `AgentInvocation.callerPat`.
 *
 * `defaultMemory` is `none` — Chat is single-shot per request.
 * Conversational state (if any) is the engine HTTP handler's
 * concern; the agent itself answers one question per run.
 */
import type { AgentDefinition } from "../../agent-harness/index.js";

export const CHAT_DEFINITION: AgentDefinition = {
  slug: "chat",
  version: "1.0.0",
  description:
    "Conversational read-only worker. PAT-scoped — every MCP read carries the user's gitea PAT.",
  outputSchemaName: "ChatOutput",
  defaultMemory: { type: "none" },
  // Read-only tool surface, same shape as Lint
  // (worldview/index/wiki page reads). The automation_drift
  // detector flags any past tool_calls[].name not in this set.
  toolNames: ["worldview.read", "index.search", "wiki.read_page"],
};
