export {
  converterDocling,
  CONVERTER_DOCLING_SLUG,
  CONVERTER_DOCLING_MIME_TYPES,
  type DoclingConverterDeps,
} from "./adapter.js";
export {
  DoclingHttpClient,
  type DoclingClient,
  type DoclingClientConvertArgs,
  type DoclingClientResponse,
  type DoclingHttpClientOptions,
} from "./client.js";
// Re-export ConversionError so adapter consumers don't need to pull
// it in from the contract-tests module directly.
export { ConversionError } from "@opencoo/shared/adapter-contract-tests/document-converter";
