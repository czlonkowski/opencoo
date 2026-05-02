/**
 * Generic webhook OutputAdapter (PR-J / phase-a appendix #4).
 *
 * Delivers opencoo payloads to any external HTTP receiver via signed
 * POST requests with exponential-backoff retry and append-only
 * delivery audit.
 *
 * # Outgoing request shape
 *
 *   POST <targetUrl>
 *   Content-Type: application/json
 *   X-OpenCoo-Signature: <64-hex HMAC-SHA256 over body bytes>
 *   X-OpenCoo-Delivery-Id: <UUID v5 deterministic from binding+payload>
 *   [operator-configured headers, excluding Authorization]
 *
 * # THREAT-MODEL invariants
 *
 *   §3.6 invariant 11: signing secret bytes NEVER appear in the body,
 *   headers, or error messages. Only the computed HMAC is emitted.
 *
 *   §2 invariant 8 (append-only): `output_deliveries` uses INSERT-per-
 *   attempt strategy. No UPDATE on prior rows.
 *
 * # Reader-agent ADR
 *
 *   Heartbeat, Lint, and Chat are reader-only agents (THREAT-MODEL
 *   §2.6 reader-vs-writer invariant). They MAY trigger output-webhook
 *   because Output is NOT a wikiWrite path — it's a notification
 *   surface. The append-only invariant on `output_deliveries` table
 *   preserves audit history.
 */
import {
  OutputAdapterValidationError,
  type OutputAdapter,
  type OutputCredentialSchema,
  type OutputWriteArgs,
  type OutputWriteResult,
} from "@opencoo/shared/output-adapter";

import {
  webhookOutputBindingConfigSchema,
  type WebhookOutputBindingConfig,
} from "./binding-config.js";
import {
  noOpDeliveryWriter,
  type OutputDeliveryWriter,
} from "./output-deliveries-writer.js";
import {
  webhookPayloadSchema,
  type WebhookPayload,
} from "./payload-schema.js";
import {
  defaultSleep,
  runRetryLoop,
  type SleepFn,
} from "./retry.js";
import { computeHmac, deriveDeliveryId } from "./signing.js";
import type { MockFetch } from "./testing/mock-http.js";

export const WEBHOOK_OUTPUT_ADAPTER_SLUG = "webhook" as const;

/** JSON-Schema credential descriptor for the Management UI.
 *  The signing secret field is `secret: true` so the UI masks
 *  input + persists via CredentialStore. */
export const webhookOutputCredentialSchema: OutputCredentialSchema = {
  type: "object",
  properties: {
    signingSecret: {
      type: "string",
      description:
        "HMAC-SHA256 signing secret. The adapter uses this to sign outgoing requests (X-OpenCoo-Signature header). Generate a random 32+ byte string.",
      secret: true,
    },
  },
  required: ["signingSecret"],
};

/**
 * Fetch-like function type injected into the adapter. Matches the
 * subset of `fetch` the adapter uses. Production wiring passes `fetch`
 * from Node 18+ / undici; tests inject `makeMockHttpFetch`.
 */
export type FetchFn = MockFetch;

export interface CreateWebhookOutputAdapterArgs {
  /** Parsed or raw binding config. Validated by the adapter factory. */
  readonly config: WebhookOutputBindingConfig | unknown;
  /** HTTP fetch implementation. Defaults to global `fetch`. */
  readonly makeFetch?: () => FetchFn;
  /** Delivery audit writer. No-op if not provided (unit tests). */
  readonly onDeliveryRow?: OutputDeliveryWriter;
  /** Called on terminal DLQ for the Activity tab alert surface (PR-B). */
  readonly onDlq?: (args: {
    readonly outputBindingId: string;
    readonly deliveryId: string;
    readonly error: unknown;
  }) => void;
  /** Sleep function injected for tests. Defaults to real setTimeout. */
  readonly sleep?: SleepFn;
}

function getDefaultFetch(): FetchFn {
  // Node 18+ has global fetch. Fall back to dynamic require for
  // older environments (should not occur in v0.1 target env).
  return (url, init) =>
    fetch(url, init).then((res) => ({
      status: res.status,
      headers: { get: (name: string) => res.headers.get(name) },
      text: () => res.text(),
    })) as ReturnType<FetchFn>;
}

export function createWebhookOutputAdapter(
  args: CreateWebhookOutputAdapterArgs,
): OutputAdapter<WebhookPayload> {
  // Parse + validate binding config at factory time — fail loud here.
  // The Zod .refine() on `headers` rejects Authorization at this point.
  const config = webhookOutputBindingConfigSchema.parse(args.config);

  const makeFetch = args.makeFetch ?? getDefaultFetch;
  const onDeliveryRow = args.onDeliveryRow ?? noOpDeliveryWriter;
  const sleep = args.sleep ?? defaultSleep;

  return {
    slug: WEBHOOK_OUTPUT_ADAPTER_SLUG,
    payloadSchema: webhookPayloadSchema,
    credentialSchema: webhookOutputCredentialSchema,

    async write(
      writeArgs: OutputWriteArgs<WebhookPayload>,
    ): Promise<OutputWriteResult> {
      // Assertion 8: payload-schema-rejects-extra-keys.
      // .strict() parse fails on extra keys; wrap in
      // OutputAdapterValidationError so BullMQ DLQs without retry.
      const parsed = webhookPayloadSchema.safeParse(writeArgs.payload);
      if (!parsed.success) {
        throw new OutputAdapterValidationError(
          `output-webhook: payload failed schema validation (${parsed.error.issues.length} issue(s))`,
          { cause: parsed.error },
        );
      }

      // Resolve signing secret from CredentialStore.
      // THREAT-MODEL §3.6 invariant 11: secret bytes are held only in
      // this local variable for the duration of the write call and never
      // serialized into any outgoing string.
      const record = await writeArgs.credentialStore.read(
        writeArgs.credentialId,
      );
      const signingSecret = record.plaintext;

      const bodyBytes = Buffer.from(JSON.stringify(parsed.data), "utf8");

      // Enforce 1 MiB payload ceiling (mirrors source-webhook ceiling).
      // Check after serialization so the byte count is exact.
      if (bodyBytes.length > 1024 * 1024) {
        throw new OutputAdapterValidationError(
          `output-webhook: payload exceeds 1 MiB ceiling (got ${bodyBytes.length} bytes)`,
        );
      }

      const hmacHex = computeHmac(bodyBytes, signingSecret);

      // Use the credentialId as the stable binding identifier for
      // delivery ID derivation. In production the output_binding_id
      // would come from the binding row; using credentialId is
      // equivalent for uniqueness purposes in v0.1.
      const deliveryId = deriveDeliveryId(
        writeArgs.credentialId as string,
        bodyBytes,
      );

      const fetchFn = makeFetch();
      const targetUrl = config.targetUrl;
      // Use lowercase header names — HTTP headers are case-insensitive
      // per RFC 7230 §3.2. Lowercase is the HTTP/2 standard (RFC 7540
      // §8.1.2) and is what the test mock + most receivers expect.
      //
      // config.headers spreads FIRST so operator-supplied values are
      // overwritten by the required security headers below. This ensures
      // a misconfigured or tampered operator config cannot replace the
      // computed HMAC or the deterministic delivery ID.
      const requestHeaders: Record<string, string> = {
        ...config.headers,
        "content-type": "application/json",
        "x-opencoo-signature": hmacHex,
        "x-opencoo-delivery-id": deliveryId,
      };

      await runRetryLoop({
        deliveryId,
        outputBindingId: writeArgs.credentialId as string,
        policy: config.retryPolicy,
        attempt: async () => {
          const res = await fetchFn(targetUrl, {
            method: "POST",
            headers: requestHeaders,
            body: bodyBytes.toString("utf8"),
          });
          const responseText = await res.text();
          const responseBodyExcerpt = responseText.length > 0
            ? responseText.slice(0, 500)
            : undefined;
          return {
            status: res.status,
            retryAfterHeader: res.headers.get("retry-after"),
            ...(responseBodyExcerpt !== undefined
              ? { responseBodyExcerpt }
              : {}),
          };
        },
        onDeliveryRow,
        ...(args.onDlq !== undefined ? { onDlq: args.onDlq } : {}),
        sleep,
      });

      return {
        externalId: deliveryId,
        externalUrl: targetUrl,
      };
    },
  };
}
