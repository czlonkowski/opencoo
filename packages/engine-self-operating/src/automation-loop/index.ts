/**
 * Public surface for the automation-loop helpers (PR 21 /
 * plan #102). Surfacer + Builder share the candidate
 * insertion + Gate 2 check + post-build flip.
 */
export {
  insertCandidate,
  markBuilt,
  requireApproved,
  type AutomationCandidate,
  type InsertCandidateArgs,
} from "./candidates.js";

export { BuilderGate2Error } from "./errors.js";
