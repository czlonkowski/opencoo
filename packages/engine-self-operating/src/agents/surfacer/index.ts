/**
 * Public surface for the Surfacer agent (PR 21 / plan #102).
 * The composition root (PR 30 CLI) registers the definition
 * and wires the body via
 * `invokeAgent({ run: ctx => runSurfacer(ctx, ...) })`.
 */
export { SURFACER_DEFINITION } from "./definition.js";
export {
  runSurfacer,
  type RunSurfacerArgs,
  type RunSurfacerResult,
} from "./run.js";
export {
  SURFACER_CANDIDATE_SCHEMA,
  SURFACER_OUTPUT_SCHEMA,
  type SurfacerCandidate,
  type SurfacerOutput,
} from "./types.js";
