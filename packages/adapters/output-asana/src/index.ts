/**
 * Public surface for `@opencoo/output-asana` (PR 24 / plan #115).
 *
 * OutputAdapter for Asana — creates tasks. Production wiring
 * (PR 30 composition root) wraps the real Asana SDK; tests
 * inject `makeMockAsanaApi` from `./testing`.
 */
export {
  ASANA_OUTPUT_ADAPTER_SLUG,
  asanaOutputCredentialSchema,
  createAsanaOutputAdapter,
  type CreateAsanaOutputAdapterArgs,
  type MakeAsanaApi,
} from "./adapter.js";

export {
  asanaTaskPayloadSchema,
  type AsanaTaskPayload,
} from "./payload-schema.js";

export {
  type AsanaApiError,
  type AsanaCreateTaskArgs,
  type AsanaCreateTaskResult,
  type AsanaLikeApi,
} from "./asana-api.js";
