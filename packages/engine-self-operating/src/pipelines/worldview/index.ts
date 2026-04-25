/**
 * Public surface for the worldview compilation pipeline
 * (PR 22 / plan #106).
 */
export {
  decideWorldviewDebounce,
  DEBOUNCE_DELAY_2_EVENTS_MS,
  DEBOUNCE_DELAY_3_EVENTS_MS,
  DEBOUNCE_DELAY_4_PLUS_EVENTS_MS,
  type WorldviewDebounceArgs,
  type WorldviewDebounceDecision,
} from "./debounce.js";

export {
  compileDomainWorldview,
  type CompileDomainArgs,
  type CompileDomainResult,
} from "./compile-domain.js";

export {
  compileCompanyWorldview,
  SOVEREIGN_AGGREGATOR_INPUT_PATH,
  type CompileCompanyArgs,
  type CompileCompanyResult,
} from "./compile-company.js";

export {
  SovereigntySpyWikiAdapter,
  type SovereigntySpyOptions,
} from "./sovereignty-spy.js";

export {
  WorldviewOverflowError,
  WorldviewSovereigntyError,
} from "./errors.js";

export {
  WORLDVIEW_BODY_MAX_BYTES,
  WORLDVIEW_OUTPUT_SCHEMA,
  utf8ByteLength,
  type WorldviewOutput,
} from "./types.js";
