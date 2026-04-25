/**
 * Public surface for `@opencoo/shared/output-adapter` (PR 24 /
 * plan #115). The OutputAdapter port + error taxonomy.
 */
export {
  type OutputAdapter,
  type OutputCredentialField,
  type OutputCredentialSchema,
  type OutputWriteArgs,
  type OutputWriteResult,
} from "./interface.js";

export {
  OutputAdapterError,
  OutputAdapterTransientError,
  OutputAdapterUpstreamQuotaError,
  OutputAdapterValidationError,
  classifyHttpError,
  type OutputAdapterErrorClass,
  type OutputAdapterErrorOptions,
} from "./errors.js";
