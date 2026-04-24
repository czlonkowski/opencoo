/**
 * DoclingClient — narrow surface over the Docling sidecar's REST API.
 *
 * v0.1 only uses `convert(args) → { markdown, structureSignals? }`.
 * `structureSignals` from Docling, when present, is advisory — the
 * adapter always re-derives its own signals from the final scrubbed
 * Markdown (THREAT-MODEL §3.2: we trust the output of OUR pipeline,
 * not the sidecar's self-reported stats).
 *
 * The HTTP client disables remote resource fetching, OLE/XSLT
 * expansion, and macro evaluation in the POST body. If Docling's exact
 * flag names differ between versions, we document the expected config
 * in the adapter README — the flag SET (not the names) is the
 * non-negotiable part.
 */
import type { StructureSignals } from "@opencoo/shared/adapter-contract-tests/document-converter";

export interface DoclingClientConvertArgs {
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly filename: string;
}

export interface DoclingClientResponse {
  readonly markdown: string;
  readonly structureSignals?: Partial<StructureSignals>;
}

export interface DoclingClient {
  convert(args: DoclingClientConvertArgs): Promise<DoclingClientResponse>;
}

// ---------------------------------------------------------------------------
// HTTP implementation
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

export interface DoclingHttpClientOptions {
  readonly url: string;
  readonly fetchImpl?: typeof fetch;
  /** Request timeout in ms; default 30s. Docling PDF conversions for
   *  large documents can legitimately hit the 20-30s range. */
  readonly timeoutMs?: number;
}

interface DoclingApiResponse {
  readonly markdown?: unknown;
  readonly structureSignals?: unknown;
}

function isDoclingApiResponse(value: unknown): value is DoclingApiResponse {
  return typeof value === "object" && value !== null;
}

/**
 * Real HTTP client pointed at a Docling sidecar. Disables external
 * resource fetching in every request — we never want Docling to
 * follow an image URL, expand an OLE-embedded object, or execute an
 * XSLT reference. The final `options.disable_*` flag names mirror
 * Docling's v1alpha convention; the flag SET is the invariant.
 *
 * Endpoint: `${url}/v1alpha/convert/source`. Payload is multipart-free
 * — we post JSON with base64 bytes. That's slower than multipart but
 * avoids a form-encoding dependency for the adapter and matches how
 * the PoC consumes Docling today.
 */
export class DoclingHttpClient implements DoclingClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DoclingHttpClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async convert(
    args: DoclingClientConvertArgs,
  ): Promise<DoclingClientResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.url}/v1alpha/convert/source`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: args.filename,
            mime_type: args.mimeType,
            content_b64: args.bytes.toString("base64"),
            // Security-critical Docling flags. Names mirror the
            // v1alpha spec; the SET of disabled behaviours is the
            // invariant — adjust names but never loosen the intent.
            options: {
              disable_remote_fetch: true,
              disable_ole_embedded: true,
              disable_xslt_expansion: true,
              disable_macros: true,
            },
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(
          `Docling returned HTTP ${response.status} for ${args.filename}`,
        );
      }
      const raw: unknown = await response.json();
      if (!isDoclingApiResponse(raw) || typeof raw.markdown !== "string") {
        throw new Error(
          `Docling response missing markdown field for ${args.filename}`,
        );
      }
      // structureSignals is advisory — we pass through whatever Docling
      // reports but the adapter re-derives its own from the final
      // scrubbed Markdown, so we don't validate its inner shape here.
      if (
        typeof raw.structureSignals === "object" &&
        raw.structureSignals !== null
      ) {
        return {
          markdown: raw.markdown,
          structureSignals: raw.structureSignals as Partial<StructureSignals>,
        };
      }
      return { markdown: raw.markdown };
    } finally {
      clearTimeout(timer);
    }
  }
}
