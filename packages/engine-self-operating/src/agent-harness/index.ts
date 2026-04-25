// Public surface for the engine-self-operating Agent harness
// (PR 19, plan #87). Concrete agents (Heartbeat, Lint, Builder,
// Chat, Surfacer) arrive in PR 20+ and consume:
//   - AgentDefinitionRegistry (registers their definition + Zod
//     output schema at boot),
//   - invokeAgent (the orchestrator that wires instance loader,
//     spotlit memory, run recorder, and LlmRouter together).

export {
  AgentDefinitionRegistry,
  syncDefinitions,
  type AgentDefinition,
  type SyncDefinitionsArgs,
  type SyncDefinitionsDb,
} from "./definitions.js";

export {
  EXACT_DENY_TOOLS,
  DENY_PREFIXES,
  isDenied,
  assertToolAllowed,
} from "./deny-list.js";

export {
  AgentDenyListError,
  AgentInstanceNotFoundError,
  AgentRunAlreadyTerminalError,
} from "./errors.js";

export {
  invokeAgent,
  type AgentInvocation,
  type AgentInvocationResult,
  type AgentRunContext,
} from "./harness.js";

export {
  loadInstanceById,
  loadInstanceBySlugAndName,
  type AgentInstance,
} from "./instances.js";

export {
  loadInstanceMemory,
  type InstanceMemory,
  type MemoryEntry,
} from "./memory.js";

export {
  completeRun,
  startRun,
  type AgentTrigger,
  type CompleteRunArgs,
  type ErrorClass,
  type StartRunArgs,
  type StartRunResult,
  type TerminalStatus,
} from "./recorder.js";
