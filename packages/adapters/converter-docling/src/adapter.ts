/**
 * `converter-docling` — DocumentConverterAdapter backed by a Docling
 * sidecar. THREAT-MODEL §3.2: the adapter's job is not to TRUST Docling
 * but to CAGE it — scrub hostile HTML, cap degradation heuristics, fail
 * closed on any sidecar error, and apply `@opencoo/shared/text-normalize`
 * exactly once on the way out.
 *
 * Pipeline per convert() call:
 *   1. Client round-trip (transport + mandatory disable_* flags).
 *   2. `stripHostileHtml` — neutralise script-adjacent tags and URIs.
 *   3. `@opencoo/shared/text-normalize` — canonical normalisation pass.
 *   4. `buildResult` — re-derive StructureSignals from the SCRUBBED
 *      text, then apply v0.1 degradation heuristics.
 *
 * Any thrown error becomes a `ConversionError('malformed-input')` —
 * the sidecar has no way to tell "bad bytes" from "transport hiccup",
 * and the safest ingestion posture is to DLQ the document for a human.
 * Router-side retry policy keys on `errorClass: 'validation'` so the
 * pipeline won't hot-loop on the same poisoned file.
 */
import { normalize } from "@opencoo/shared/text-normalize";
import {
  ConversionError,
  type ConvertArgs,
  type ConversionResult,
  type DocumentConverterAdapter,
} from "@opencoo/shared/adapter-contract-tests/document-converter";

import type { DoclingClient } from "./client.js";
import { stripHostileHtml } from "./strip-html.js";
import { buildResult } from "./extract-signals.js";

export const CONVERTER_DOCLING_SLUG = "converter-docling";

// v0.1 MIME types. Images + OCR are explicitly deferred to v0.2 —
// extending this list requires adding a degradation heuristic (or an
// explicit "no heuristic" carve-out) and a contract-suite fixture.
export const CONVERTER_DOCLING_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/html",
] as const;

export interface DoclingConverterDeps {
  readonly client: DoclingClient;
}

class DoclingConverter implements DocumentConverterAdapter {
  readonly slug = CONVERTER_DOCLING_SLUG;
  readonly mimeTypes = CONVERTER_DOCLING_MIME_TYPES;

  constructor(private readonly deps: DoclingConverterDeps) {}

  async convert(args: ConvertArgs): Promise<ConversionResult> {
    let rawMarkdown: string;
    try {
      const response = await this.deps.client.convert({
        bytes: args.bytes,
        mimeType: args.mimeType,
        filename: args.filename,
      });
      rawMarkdown = response.markdown;
    } catch (cause) {
      throw new ConversionError(
        `converter-docling: sidecar failed to convert ${args.filename}`,
        "malformed-input",
        { cause },
      );
    }

    // Strip hostile HTML BEFORE normalize so the normalizer's line/NFC
    // handling doesn't "stabilise" malformed markup into something the
    // scrubber misses. Order is load-bearing: scrub, then normalise.
    const scrubbed = stripHostileHtml(rawMarkdown);
    const normalised = normalize(scrubbed);
    return buildResult(normalised, args.mimeType);
  }
}

/**
 * Factory. Prefer this over constructing the class directly — it keeps
 * the call shape symmetric with the other `@opencoo/<slug>()` adapter
 * entrypoints and makes it trivial to add wrapping (instrumentation,
 * circuit-breaker) behind the same name later.
 */
export function converterDocling(
  deps: DoclingConverterDeps,
): DocumentConverterAdapter {
  return new DoclingConverter(deps);
}
