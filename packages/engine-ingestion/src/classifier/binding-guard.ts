/**
 * `assertBindingNotWildcardOnly` — fail-closed runtime guard for
 * binding `allowed_paths` (THREAT-MODEL §3.4, Q5).
 *
 * PR-W1 (phase-a appendix #14) moved the canonical definition into
 * `@opencoo/shared/source-adapter` so the admin-API POST/PATCH paths
 * in `@opencoo/engine-self-operating` can pre-validate the same
 * shape without crossing the cross-engine boundary
 * (`opencoo/no-cross-engine-import`). This file remains the runtime
 * call-site of the guard (the classifier still imports
 * `assertBindingNotWildcardOnly` from `./binding-guard.js`) — it
 * re-exports the symbols from shared so the existing import path,
 * the `packages/engine-ingestion/src/classifier/index.ts` re-export,
 * and the public package surface (`packages/engine-ingestion/src/index.ts`)
 * keep working unchanged.
 *
 * Behavior is byte-identical to the pre-W1 implementation; the move
 * is purely about reachability across the boundary.
 */

export {
  assertBindingNotWildcardOnly,
  BindingConfigError,
} from "@opencoo/shared/source-adapter";
