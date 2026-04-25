/**
 * Public surface for the Chat agent (PR 20 part B / plan #97).
 * The composition root (PR 30 CLI / engine HTTP handler)
 * registers the definition and wires the body via
 * `invokeAgent({ run: ctx => runChat(ctx, ...), callerPat })`.
 */
export { CHAT_DEFINITION } from "./definition.js";
export { ChatPatRequiredError } from "./errors.js";
export { runChat, type RunChatArgs } from "./run.js";
export { CHAT_OUTPUT_SCHEMA, type ChatOutput } from "./types.js";
