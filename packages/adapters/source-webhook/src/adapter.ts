/**
 * Generic webhook SourceAdapter — the integration bridge for any
 * external system that doesn't have a dedicated adapter (PR-I /
 * phase-a appendix #4).
 *
 * Architecture pin: the pattern is identical to source-asana —
 * HMAC verification lives in the engine-ingestion receiver, NOT
 * here. This adapter EXPORTS the verifier + helpers; the receiver
 * composes them (orchestrator override 5).
 *
 * Receiver flow (engine-ingestion webhook-receiver.ts):
 *   1. Look up binding → resolve adapter via slug 'webhook'.
 *   2. Read HMAC secret via credentialStore.read(
 *      config.signingSecretCredentialId).
 *   3. adapter.webhook.extractSignature(headers) → string | undefined.
 *   4. adapter.webhook.verifier.verify({ body, secret, signature }).
 *   5. On ok=false → 401 + DLQ.
 *   6. On ok=true → adapter.webhook.parseEvents({ body }) →
 *      SourceWebhookEvent[]; enqueue scanner jobs. Replay dedup
 *      happens at the intake layer's UNIQUE
 *      (binding_id, source_doc_id, source_revision) constraint —
 *      the body-derived event_id flows into sourceDocId +
 *      sourceRevision on the ingested document.
 *
 * THREAT-MODEL §3.1 (HMAC + replay):
 *   - HMAC-SHA256 via HmacSha256Verifier (reused from @opencoo/shared).
 *   - event_id extracted via eventIdField jsonpath; extraction failure
 *     throws ValidationError (fail-closed — no id = no sourceDocId =
 *     no ingest). The derived event_id becomes sourceDocId +
 *     sourceRevision on the ingested document; the intake layer dedupes
 *     via (binding_id, source_doc_id, source_revision) UNIQUE.
 *
 * THREAT-MODEL §3.7 (review-mode default):
 *   - reviewMode defaults to 'review'. Operator must explicitly set
 *     'auto' after manual sanity-check in the Review Dashboard.
 *
 * THREAT-MODEL §3.6 invariant 11 (no signing-secret bytes in errors):
 *   - Error messages NEVER include secret bytes. The signing secret is
 *     only touched by the receiver (via CredentialStore); this module
 *     never sees the raw bytes.
 */
import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { ContentKind, CredentialId } from "@opencoo/shared/db";
import { ValidationError } from "@opencoo/shared/errors";
import type {
  SourceAdapter,
  SourceScanArgs,
  SourceScanResult,
  SourceWebhookEvent,
  SourceWebhookHelpers,
} from "@opencoo/shared/source-adapter";
import {
  HmacSha256Verifier,
  type WebhookVerifier,
} from "@opencoo/shared/webhook-verifier";

import {
  sourceWebhookBindingConfigSchema,
  type SourceWebhookBindingConfig,
} from "./binding-config.js";
import { resolveContentKind } from "./content-kind-mapping.js";
import { deriveEventId } from "./event-id-derivation.js";

export const WEBHOOK_ADAPTER_SLUG = "webhook" as const;

/**
 * Header name the receiver uses for generic webhook signatures
 * (inbound direction — sender → opencoo receiver).
 * Case-insensitive lookup (see extractWebhookSignature).
 *
 * Canonical inbound header: `x-signature`
 *
 * Senders must include: `X-Signature: <hex-hmac-sha256>`
 * Also accepted: `X-Signature: sha256=<hex>` (GitHub style).
 *
 * Asymmetry note: this differs BY DESIGN from the outbound header
 * used by PR-J's WebhookOutputAdapter (`X-OpenCoo-Signature`).
 * Inbound uses `x-signature` because we are the receiver and
 * external senders already set their own header conventions;
 * outbound uses `X-OpenCoo-Signature` because opencoo is the
 * sender and asserts its own identity. Different security models —
 * operator-trusted inbound vs opencoo-asserted outbound.
 */
export const WEBHOOK_SIGNATURE_HEADER = "x-signature";

export interface CreateSourceWebhookAdapterArgs {
  readonly credentialStore: CredentialStore;
  readonly credentialId: CredentialId;
  readonly config: SourceWebhookBindingConfig | unknown;
}

/**
 * Options for `buildWebhookHelpers`. Allows injection of
 * the config-driven knobs without exposing the full
 * SourceWebhookBindingConfig shape in tests.
 *
 * `signingSecretCredentialId` is accepted for backwards-compat but
 * unused inside `buildWebhookHelpers` — the signing secret is
 * resolved by the receiver from `binding.credentialsId`, not here.
 * @deprecated signingSecretCredentialId — kept for API compatibility;
 *   will be removed in v0.2.
 */
export interface BuildWebhookHelpersOptions {
  /** @deprecated Kept for API compat; not read at runtime. */
  readonly signingSecretCredentialId: string;
  readonly eventIdField: string;
  readonly contentKindMap?: Record<string, string>;
  readonly defaultContentKind?: ContentKind;
}

/**
 * Case-insensitive header lookup. Header names may be lower-cased
 * (Fastify normalises) or original-case (raw injection in tests).
 *
 * HTTP headers can be `string | string[] | undefined`. For signature
 * headers we take the last value when an array is present (defensive;
 * senders never duplicate these).
 */
function findHeaderValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  headerName: string,
): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== headerName) continue;
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.length > 0) return v[v.length - 1];
  }
  return undefined;
}

export function extractWebhookSignature(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
  return findHeaderValue(headers, WEBHOOK_SIGNATURE_HEADER);
}

/**
 * (PR-Q7) Unwrap the inner `signing_secret` from the credential
 * plaintext bytes the admin-API source-bindings write path stored.
 *
 * Mirrors source-asana / source-fireflies. The generic webhook
 * adapter's webhook_secret schema (see
 * `SOURCE_ADAPTER_CREDENTIAL_SCHEMAS.webhook.credentialSchema.properties.webhook_secret`)
 * declares a single `signing_secret` field. The admin-API encrypts
 * `JSON.stringify({ signing_secret: "..." })`; senders sign the
 * request body with the raw inner secret value, so the receiver MUST
 * unwrap before calling the HMAC verifier.
 *
 * Throws on malformed JSON or a missing inner field — both indicate a
 * credential-write-side bug worth surfacing to the operator. THREAT-
 * MODEL §3.6 invariant 11: the error message NEVER includes secret
 * bytes; the JSON-parse error path could in theory leak parsed bytes
 * through Node's reporter, so the engine-ingestion receiver routes
 * the throw through `safeErrorMessage` (scrub + 200-char cap) before
 * any logging.
 */
export function extractWebhookCredentialSecret(plaintext: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch (err) {
    throw new Error(
      `source-webhook: webhook credential plaintext is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "source-webhook: webhook credential plaintext must be a JSON object with a signing_secret field",
    );
  }
  const inner = (parsed as Record<string, unknown>)["signing_secret"];
  if (typeof inner !== "string" || inner.length === 0) {
    throw new Error(
      "source-webhook: webhook credential is missing the signing_secret field (or it is not a non-empty string) — check the binding's webhook_secret credential write",
    );
  }
  return Buffer.from(inner, "utf8");
}

const ONE_MIB = 1024 * 1024;

/**
 * Parse a generic webhook body into SourceWebhookEvents.
 *
 * One body → one event (the whole payload IS the event).
 * This is intentional: generic webhook adapters don't batch events.
 * Adapters that want event-array unpacking use a dedicated adapter
 * (source-asana unpacks body.events[]).
 *
 * Per-event contract (architecture §10 / plan #115):
 *   - eventId = value extracted via eventIdField jsonpath
 *   - sourceDocId = eventId (event-id is the natural key)
 *   - sourceRevision = eventId (each event = one revision)
 *   - sourceRef = `webhook:<slug>/<eventId>`
 *   - contentBytes = Buffer.from(JSON.stringify(payload)) — 1 MiB ceiling
 *   - fetchedAt = now (or injected via args.fetchedAt)
 *
 * THREAT-MODEL §3.1: eventId must be deterministic for replay dedup.
 * THREAT-MODEL §3.6 inv 11: errors NEVER contain secret bytes.
 */
function parseWebhookBody(
  body: Buffer,
  config: Pick<
    BuildWebhookHelpersOptions,
    "eventIdField" | "contentKindMap" | "defaultContentKind"
  >,
  fetchedAt: Date,
): readonly SourceWebhookEvent[] {
  // Step 1: Parse JSON body.
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch (err) {
    throw new ValidationError(
      `source-webhook: body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (typeof payload !== "object" || payload === null) {
    throw new ValidationError(
      "source-webhook: body root must be a JSON object",
    );
  }

  // Step 2: Extract event_id via jsonpath — fail-closed.
  // deriveEventId throws ValidationError when path resolves to nothing.
  const eventId = deriveEventId(payload, config.eventIdField);

  // Step 3: Enforce 1 MiB ceiling on contentBytes.
  // We compute contentBytes BEFORE the ceiling check so the check
  // reflects the actual serialised size.
  const contentBytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (contentBytes.length > ONE_MIB) {
    throw new ValidationError(
      `source-webhook: payload exceeds 1 MiB ceiling (got ${contentBytes.length} bytes)`,
    );
  }

  // Step 4: Resolve content_kind.
  // Stored in metadata so the Classifier can use it for routing
  // (the adapter signals the intended kind; the Classifier may
  // confirm or override based on content analysis).
  // Default is 'document' — the only kind with a Compiler template in v0.1.
  // 'webhook-event' is in CONTENT_KINDS for forward-compat but has no
  // template yet; operators using that kind get events the Compiler
  // cannot route.
  const defaultKind: ContentKind = config.defaultContentKind ?? "document";
  const contentKind = resolveContentKind(
    payload,
    config.contentKindMap,
    defaultKind,
  );

  return [
    {
      eventId,
      doc: {
        sourceDocId: eventId,
        sourceRevision: eventId,
        sourceRef: `webhook:event/${eventId}`,
        fetchedAt,
        contentBytes,
        metadata: { contentKind },
      },
    },
  ];
}

export function buildWebhookHelpers(
  opts: BuildWebhookHelpersOptions,
): SourceWebhookHelpers {
  const verifier: WebhookVerifier = new HmacSha256Verifier();
  const defaultKind: ContentKind = opts.defaultContentKind ?? "document";

  return {
    verifier,
    extractSignature: extractWebhookSignature,
    extractWebhookSecret: extractWebhookCredentialSecret,
    parseEvents({
      body,
      fetchedAt,
    }: {
      readonly body: Buffer;
      readonly fetchedAt?: Date;
    }): readonly SourceWebhookEvent[] {
      return parseWebhookBody(body, opts, fetchedAt ?? new Date());
    },
    /**
     * (PR-N2, phase-a appendix #6) Re-resolve `metadata.contentKind`
     * for every event by re-running the per-binding `contentKindMap`
     * jsonpath rules against each event's body. Idempotent — for
     * events emitted by this adapter's own `parseEvents`, the kind
     * is already set, and re-resolution returns the same value.
     *
     * Why is this an explicit hook instead of "just leave parseEvents
     * to do it"? The engine-ingestion webhook receiver uses
     * `adapter.webhook.enrichEvents !== undefined` as the load-bearing
     * flag that flips its **direct-intake fast path** on (rather than
     * the legacy `intake.scanner` enqueue). Webhook-native adapters
     * with `enrichEvents` produce `ingestion_intake` rows directly via
     * the receiver; periodic `scan()` remains the canonical path for
     * snapshot adapters (Drive, etc.) per `docs/ARCHITECTURE.md` §7
     * (Adapter boundaries — webhook-native vs polling adapters).
     *
     * Defense in depth: a future caller that hand-builds a
     * `SourceWebhookEvent` from outside `parseEvents` would skip the
     * jsonpath resolution. enrichEvents catches those by re-deriving
     * the kind from `event.doc.contentBytes`.
     *
     * Round-3 (Copilot #3): on `JSON.parse` failure, the event is
     * preserved with the existing/defaulted `metadata.contentKind`
     * rather than dropped — graceful degradation is the v0.1
     * choice. The receiver still ingests the bytes; the Compiler
     * decides what to do with an unrecognized content kind via its
     * existing `'document'`-fallback path. (Adapter-emitted events
     * never hit this branch — `parseEvents` rejects malformed
     * bodies upstream with `ValidationError`.)
     */
    async enrichEvents(
      events: readonly SourceWebhookEvent[],
    ): Promise<readonly SourceWebhookEvent[]> {
      return events.map((event) => {
        let payload: unknown;
        try {
          payload = JSON.parse(event.doc.contentBytes.toString("utf8"));
        } catch {
          // Malformed body — leave existing metadata.contentKind in
          // place (parseEvents would have already rejected this body
          // for adapter-emitted events; defense in depth for
          // hand-built events). Fall back to the default.
          return {
            ...event,
            doc: {
              ...event.doc,
              metadata: {
                ...event.doc.metadata,
                contentKind: event.doc.metadata?.["contentKind"] ?? defaultKind,
              },
            },
          };
        }
        const contentKind = resolveContentKind(
          payload,
          opts.contentKindMap,
          defaultKind,
        );
        return {
          ...event,
          doc: {
            ...event.doc,
            metadata: {
              ...event.doc.metadata,
              contentKind,
            },
          },
        };
      });
    },
  };
}

export function createSourceWebhookAdapter(
  args: CreateSourceWebhookAdapterArgs,
): SourceAdapter {
  // Parse + validate config at factory time — fail loud here.
  const config = sourceWebhookBindingConfigSchema.parse(args.config);

  // credentialStore + credentialId are part of the factory shape
  // (THREAT-MODEL §3.6 invariant 11) but unused by webhook-mode
  // adapters: the engine-ingestion receiver resolves the actual
  // webhook signing secret from `binding.credentialsId` (the DB
  // column set by POST /api/admin/source-bindings) at verify-time.
  // Note: config.signingSecretCredentialId is a deprecated dead field
  // (see binding-config.ts) and is NOT used here.
  void args.credentialStore;
  void args.credentialId;

  async function scan(_args: SourceScanArgs): Promise<SourceScanResult> {
    void _args;
    // Webhook adapters do not scan. The receiver pushes events in.
    // Return empty so a degenerate Scanner run is a no-op.
    return { documents: [], nextCursor: null };
  }

  return {
    slug: WEBHOOK_ADAPTER_SLUG,
    scan,
    webhook: buildWebhookHelpers({
      signingSecretCredentialId: config.signingSecretCredentialId,
      eventIdField: config.eventIdField,
      ...(config.contentKindMap !== undefined
        ? { contentKindMap: config.contentKindMap }
        : {}),
      defaultContentKind: config.defaultContentKind,
    }),
  };
}
