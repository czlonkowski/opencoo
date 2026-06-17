/**
 * Public surface for `@opencoo/source-okf` (PR-OKF3b).
 *
 * SourceAdapter that walks a local Open Knowledge Format (OKF) v0.1
 * bundle directory and emits each concept document as a
 * `content_kind: 'okf-bundle'` document. The engine-ingestion
 * compilation-worker routes these to the deterministic
 * `compileOkfConcept` passthrough (no LLM); the markdown body
 * round-trips byte-for-byte into the wiki (architecture §16.3).
 */
export {
  OKF_DEFAULT_CONTENT_KIND,
  okfBindingConfigSchema,
  type OkfBindingConfig,
} from "./binding-config.js";

export {
  OKF_ADAPTER_SLUG,
  createOkfSourceAdapter,
  type CreateOkfSourceAdapterArgs,
} from "./adapter.js";

/**
 * PR-OKF3b — per-adapter `allowed_paths` suggestion surfaced as a
 * click-to-add chip in the Management UI's `+ New binding` wizard.
 * Drift-checked against the authoritative registry in
 * `@opencoo/shared/source-adapter`.
 *
 * NOTE: allowed_paths is ADVISORY for `okf-bundle` bindings — the
 * compile path mirrors each concept to its bundle path verbatim and
 * does not gate on allowed_paths (only the LLM `document` path does).
 * The entry stays bounded + non-wildcard so it passes the create-time
 * guard (THREAT-MODEL §3.4).
 */
export const DEFAULT_ALLOWED_PATHS = [
  "okf/**",
] as const satisfies readonly string[];
