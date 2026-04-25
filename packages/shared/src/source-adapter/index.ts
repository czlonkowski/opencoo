/**
 * `SourceAdapter` — minimal v0.1 port for source ingestion
 * (architecture §10 SourceAdapter, plan #77 Q3 minimal surface).
 *
 * Concrete adapters (Drive, Asana, Fireflies, n8n, gitea-wiki)
 * land in PR 23+. v0.1 only ships the port shape so the Scanner
 * pipeline + the engine harness can compile against it.
 *
 * The Scanner persists `nextCursor` into
 * `sources_bindings.last_scan_cursor` after a successful scan
 * (migration 0004). The cursor is opaque: the engine does not
 * parse it; the adapter sees what it returned last time.
 *
 * The Compilation Worker inlines `contentBytes` into the
 * BullMQ job payload (1MiB cap; SpotlightOverflowError catches
 * overflow during classification). PR 23+ swaps to a re-fetch
 * pattern when adapters land — at that point `contentBytes`
 * goes away and the worker calls `adapter.fetch(sourceRef)`.
 */

export interface SourceScanArgs {
  /** Cursor persisted from the previous scan, or `null` for a
   *  first run. The adapter chooses the semantics — Drive uses
   *  a change-token, Asana uses a sync cursor, Fireflies uses
   *  a since-timestamp ISO string. */
  readonly cursor: string | null;
  /** Optional clock injection for deterministic tests. Adapters
   *  that don't need a clock ignore this field. */
  readonly now?: number;
}

export interface SourceChangedDocument {
  /** Source-system identifier — opaque text. Combined with
   *  sourceRevision to form the `ingestion_intake` UNIQUE key
   *  (binding_id, source_doc_id, source_revision). */
  readonly sourceDocId: string;
  /** Source-system version of this document — opaque text. A
   *  new sourceRevision means the body changed; same revision
   *  means a no-op (Scanner skips re-classifying). */
  readonly sourceRevision: string;
  /** Human-readable reference for audit logs and citations,
   *  e.g. `drive:1XYZ...`, `asana:task/1234`. */
  readonly sourceRef: string;
  /** When the adapter fetched this document. */
  readonly fetchedAt: Date;
  /** Inline document bytes for the Compilation Worker to
   *  consume. v0.1 inlines into the BullMQ job payload (1MiB
   *  cap); PR 23+ replaces with re-fetch. */
  readonly contentBytes: Buffer;
}

export interface SourceScanResult {
  /** Documents that changed since `cursor`. Empty array means
   *  no work for the Scanner — it persists the new cursor and
   *  exits cleanly. */
  readonly documents: readonly SourceChangedDocument[];
  /** Cursor for the NEXT scan. `null` is legal when the
   *  adapter has no resumable cursor (e.g. a stateless
   *  full-fetch adapter). */
  readonly nextCursor: string | null;
}

/**
 * Per-event shape emitted by webhook-mode adapters when their
 * `parseEvents` helper unpacks an inbound webhook body. The
 * receiver in engine-ingestion (PR 14) cross-references
 * `eventId` against the `webhook_events` UNIQUE index for
 * replay dedupe, then pushes the doc into the same intake
 * path polling-mode adapters use.
 */
export interface SourceWebhookEvent {
  /** Source-system event id (Asana `event.gid` etc.). The
   *  receiver dedupes replays on this. */
  readonly eventId: string;
  /** The doc the event surfaces, in the same shape polling
   *  adapters emit. Mostly useful in PR 30 wiring; the
   *  contract suite asserts shape. */
  readonly doc: SourceChangedDocument;
}

/**
 * Webhook-mode helpers an adapter exposes (PR 24 / plan #115).
 * Polling adapters do NOT set this. The engine-ingestion
 * webhook receiver consumes the helpers via DI:
 *
 *   1. Lookup binding → fetch webhook secret from
 *      CredentialStore.
 *   2. `extractSignature(req.headers)` → string | undefined.
 *   3. `verifier.verify({ body, secret, signature })` →
 *      reject ValidationError on failure.
 *   4. `parseEvents(body)` → list of `SourceWebhookEvent`s.
 *   5. Dedupe each `eventId` against `webhook_events` UNIQUE
 *      key; insert into intake.
 *
 * The brief / plan #115 keeps HMAC verification in the
 * RECEIVER (engine-ingestion) so the adapter package stays
 * dependency-free of req/res abstractions; the helpers below
 * are pure functions the receiver composes.
 */
export interface SourceWebhookHelpers {
  /** Verifies a body+signature against the binding's webhook
   *  secret. Stateless — caller passes everything. */
  readonly verifier: import("../webhook-verifier/interface.js").WebhookVerifier;
  /** Extracts the signature string from request headers. The
   *  header name varies by source (Asana: `X-Hook-Signature`,
   *  Gitea: `X-Hub-Signature-256`); this helper localises the
   *  detail. Returns undefined if absent. */
  extractSignature(headers: Readonly<Record<string, string | undefined>>):
    | string
    | undefined;
  /** Unpack a verified body into one or more events. Adapter
   *  is responsible for shape-validating the body — a
   *  malformed body throws ValidationError. */
  parseEvents(args: {
    readonly body: Buffer;
    readonly fetchedAt?: Date;
  }): readonly SourceWebhookEvent[];
}

export interface SourceAdapter {
  /** Stable identifier matching `sources_bindings.adapter_slug`.
   *  The Scanner pipeline picks the adapter for a binding by
   *  this slug. */
  readonly slug: string;
  /** Discover documents changed since `args.cursor`. Returns
   *  the new cursor for the engine to persist. */
  scan(args: SourceScanArgs): Promise<SourceScanResult>;
  /** Webhook-mode helpers — set only by webhook adapters
   *  (PR 24 Asana, PR 27 Fireflies). The contract suite
   *  asserts presence + behavior when `mode === 'webhook'`. */
  readonly webhook?: SourceWebhookHelpers;
}
