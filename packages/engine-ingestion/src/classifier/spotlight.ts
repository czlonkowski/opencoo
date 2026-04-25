/**
 * Engine-ingestion thin re-export of `spotlight()` from
 * `@opencoo/shared/spotlight` (PR 19 / plan #87 — promoted
 * because the agent harness in engine-self-operating ALSO
 * needs to wrap external content for prompts; both engines
 * must use byte-identical envelope semantics or an attacker
 * could pivot between them).
 *
 * Existing import paths (`./spotlight.js` from classifier
 * neighbours, the PR 15 spotlight test) keep working
 * unchanged.
 */
export {
  spotlight,
  type SpotlightArgs,
} from "@opencoo/shared/spotlight";
