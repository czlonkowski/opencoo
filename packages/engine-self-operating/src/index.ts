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
