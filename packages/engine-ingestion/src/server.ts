/**
 * Engine-ingestion thin re-export of `buildServer` from
 * `@opencoo/shared/engine-scaffold`. Kept as a stub here so
 * existing import paths (`@opencoo/engine-ingestion` barrel,
 * tests under `tests/`) keep working without churn. New code
 * should import directly from `@opencoo/shared/engine-scaffold`.
 */
export {
  buildServer,
  type BuildServerOptions,
  type ProbeFn,
  type ProbeMap,
} from "@opencoo/shared/engine-scaffold";
