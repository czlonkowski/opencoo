// Public surface for @opencoo/engine-self-operating. The
// composition root (PR 30 CLI) imports `start` to launch the
// engine; PR 19+ self-op pipelines (Heartbeat, Lint, Builder,
// Chat, Surfacer) consume the registry shape from
// @opencoo/shared/engine-scaffold (re-exported via this barrel
// for ergonomics).

export {
  loadEngineConfig,
  type EngineConfig,
} from "./config.js";

export {
  isPathWithinRoot,
  isSpaFallbackPath,
  registerStaticUi,
  type StaticUiOptions,
} from "./static-ui.js";

export {
  PipelineRegistry,
  start,
  type ProbeMap,
  type SelfOperatingRegistry,
  type StartDb,
  type StartedEngine,
  type StartOptions,
  type StartRedis,
  type StartServer,
} from "./start.js";

// Concrete reader agents (PR 20, plan #92 part A). Read-only —
// every tool call flows through the harness; no agent in this
// PR registers a writer tool.
export {
  HEARTBEAT_DEFINITION,
  HEARTBEAT_OUTPUT_SCHEMA,
  runHeartbeat,
  type HeartbeatAlert,
  type HeartbeatOutput,
  type RunHeartbeatArgs,
} from "./agents/heartbeat/index.js";

export {
  CONTRADICTIONS_OUTPUT_SCHEMA,
  CONTRADICTIONS_PAIR_CAP,
  LINT_DEFINITION,
  LINT_FINDING_KINDS,
  LINT_FINDING_SCHEMA,
  LINT_OUTPUT_SCHEMA,
  STALE_PAGES_DEFAULT_THRESHOLD_DAYS,
  currentLoaderPromptVersions,
  detectContradictions,
  detectOrphans,
  detectPromptVersionDrift,
  detectStalePages,
  detectWildcardBindings,
  runLint,
  runLintCore,
  type ContradictionsArgs,
  type LintFinding,
  type LintFindingKind,
  type LintOutput,
  type OrphansArgs,
  type PageBody,
  type PageNewestCitation,
  type PageNewestPromptVersion,
  type PromptVersionDriftArgs,
  type RunLintArgs,
  type RunLintCoreArgs,
  type StalePagesArgs,
  type WildcardBindingsInput,
} from "./agents/lint/index.js";

// Reader-agent tool wrappers — wiki.read_page / worldview.read /
// index.search adapters over McpToolClient.
export {
  indexSearch,
  wikiReadPage,
  worldviewRead,
  type IndexSearchArgs,
  type WikiReadPageArgs,
  type WorldviewReadArgs,
} from "./agents/tools/index.js";

// MCP tool-client surface (PR 20, plan #92 part A). v0.1 ships
// only the port + an in-memory test fixture; production
// `HttpMcpToolClient` arrives in PR 23+. Per Q12, the in-memory
// fixture does NOT import gitea-mcp internals — it is a pure
// data test double conforming to the same shape.
export {
  InMemoryMcpToolClient,
  McpResourceNotFoundError,
  type McpListFilter,
  type McpToolClient,
} from "./mcp-tool-client/index.js";

// Output-channel surface (PR 20, plan #92 part A). The Heartbeat
// + Lint agents return JSON; the engine's post-run hook routes
// the payload through this registry. The registry enforces the
// per-instance `outputChannelIds[]` binding so a prompt-injection
// attack on the agent cannot redirect delivery (Q10).
export {
  MockOutputChannelAdapter,
  OutputChannelMismatchError,
  OutputChannelRegistry,
  OutputChannelUnknownAdapterError,
  type CapturedDelivery,
  type OutputChannelAdapter,
  type OutputChannelBinding,
  type OutputChannelDeliverArgs,
  type OutputChannelDelivery,
  type OutputChannelDeliverInvocation,
} from "./output-channels/index.js";

// Agent harness surface (PR 19, plan #87). The composition root
// (PR 30 CLI) wires concrete agents (PR 20+) onto this harness.
export {
  AgentDefinitionRegistry,
  AgentDenyListError,
  AgentInstanceNotFoundError,
  AgentRunAlreadyTerminalError,
  EXACT_DENY_TOOLS,
  DENY_PREFIXES,
  assertToolAllowed,
  completeRun,
  invokeAgent,
  isDenied,
  loadInstanceById,
  loadInstanceBySlugAndName,
  loadInstanceMemory,
  startRun,
  syncDefinitions,
  type AgentDefinition,
  type AgentInstance,
  type AgentInvocation,
  type AgentInvocationResult,
  type AgentRunContext,
  type AgentTrigger,
  type CompleteRunArgs,
  type ErrorClass,
  type InstanceMemory,
  type MemoryEntry,
  type StartRunArgs,
  type StartRunResult,
  type SyncDefinitionsArgs,
  type SyncDefinitionsDb,
  type TerminalStatus,
} from "./agent-harness/index.js";
