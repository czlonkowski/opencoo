/**
 * Public surface for the Builder agent (PR 21 / plan #102).
 * The composition root (PR 30 CLI) registers the definition
 * and wires the body via
 * `invokeAgent({ run: ctx => runBuilder(ctx, ...) })`.
 */
export { BUILDER_DEFINITION } from "./definition.js";
export {
  runBuilder,
  type RunBuilderArgs,
  type RunBuilderResult,
} from "./run.js";
export {
  BUILDER_OUTPUT_SCHEMA,
  type BuilderOutput,
} from "./types.js";
