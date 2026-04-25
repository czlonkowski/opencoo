/**
 * Fireflies SourceAdapter — webhook mode (PR 27 / plan #126).
 *
 * Fireflies sources meeting transcripts via webhooks. The adapter
 * exposes the standard webhook-mode surface (mirrors source-asana
 * by orchestrator decision 1 — keep parser + factory + helpers
 * in one module so the package shape stays tight):
 *
 *   - `slug: 'fireflies'`
 *   - `scan()` — returns `{ documents: [], nextCursor: null }`.
 *     Webhook adapters do NOT scan; the receiver pushes events
 *     in. We satisfy the port shape so a degenerate Scanner run
 *     is a no-op (decision 7).
 *   - `webhook.verifier` — HMAC-SHA256 over the raw body,
 *     reusing `HmacSha256Verifier` from `@opencoo/shared`. NO
 *     re-implementation.
 *   - `webhook.extractSignature(headers)` — looks up
 *     `x-fireflies-signature` (case-insensitive). Decision 3 —
 *     verified against the planner's prescription; the PoC
 *     does not yet ingest Fireflies via webhook (transcripts
 *     are dropped to Drive today), so this header is the
 *     forward-looking choice.
 *   - `webhook.parseEvents({ body })` — unpacks the Fireflies
 *     webhook envelope. Decision 5: single-event-per-request.
 *     Returns an array of length 0 (filtered by
 *     `meetingTitleAllowlist`) or 1.
 *
 * # Architecture pin
 *
 * Per orchestrator override 6: spotlight-wrapping happens at
 * the LLM-call edge (PR 15), NOT at intake. The adapter
 * faithfully encodes the source bytes verbatim — full
 * transcript, speakers, timestamps, metadata.
 *
 * Per orchestrator override 5 (mirrors Asana): HMAC verification
 * stays in the engine-ingestion receiver. This adapter EXPORTS
 * the verifier; it does NOT verify on its own. Receiver flow:
 *   1. Resolve `webhookSecretCredentialId` → secret bytes.
 *   2. Call `verifier.verify({ body, secret, signature })`.
 *   3. On `ok:false`, throw `WebhookSignatureError(validation)`.
 *   4. On `ok:true`, call `parseEvents({ body })`.
 *   5. For each event, dedupe `eventId` against
 *      `webhook_events` UNIQUE (binding_id, event_id), then
 *      push into intake.
 */
import { createHash } from "node:crypto";

import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
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
import { z } from "zod";

export const FIREFLIES_ADAPTER_SLUG = "fireflies" as const;

/** Header Fireflies is configured to send signatures on
 *  (decision 3). Case-insensitive lookup via the helper below. */
export const FIREFLIES_SIGNATURE_HEADER = "x-fireflies-signature";

/** Per-event content-bytes ceiling — mirrors the SourceAdapter
 *  contract assertion 7. A transcript that serializes larger
 *  fails closed rather than overflowing the Compilation Worker
 *  prompt budget. */
const ONE_MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Binding-config (decision 1: folded into adapter.ts; decision 2:
// FULL reviewMode enum — auto|approve|review — defaulting to
// 'approve' per THREAT-MODEL §3.1 because untrusted meeting
// transcripts ship review-required by default)
// ---------------------------------------------------------------------------

/**
 * # `reviewMode` semantics — column-vs-jsonb sovereignty
 *
 * The runtime source of truth is the `sources_bindings.review_mode`
 * COLUMN, not this jsonb field. The Management UI / migration
 * path uses this jsonb default at binding-creation time to seed
 * the column; thereafter the engine reads the column. Declaring
 * it here (with the FULL enum) keeps the binding-config self-
 * documenting and lets a future operator-onboarding flow set
 * the default without touching the column directly.
 *
 * NOTE: source-asana's binding-config `reviewMode` enum is
 * missing the `'approve'` value — that's a known gap (residual
 * advisory for v0.2). Do NOT propagate that omission here.
 */
export const firefliesBindingConfigSchema = z
  .object({
    /** Reference to the webhook secret persisted in the
     *  CredentialStore. The receiver fetches the actual bytes
     *  via this reference at verify-time. */
    webhookSecretCredentialId: z.string().min(1),
    /** Default `'approve'` because the PoC's pattern (THREAT-MODEL
     *  §3.1) is that meeting transcripts are review-required —
     *  they often contain unredacted PII and the operator
     *  decides per-meeting whether to ingest. Operators with
     *  a clean meeting culture can switch to `'auto'`. */
    reviewMode: z.enum(["auto", "approve", "review"]).default("approve"),
    /**
     * Operator scope filter. Each entry is matched
     * case-insensitively as a substring against the meeting
     * title; an empty array means "ingest all meetings"
     * (default). The match runs in `parseEvents` BEFORE the
     * event is enqueued, so dropped meetings never produce a
     * `webhook_events` row.
     */
    meetingTitleAllowlist: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type FirefliesBindingConfig = z.infer<
  typeof firefliesBindingConfigSchema
>;

// ---------------------------------------------------------------------------
// Webhook envelope shape (single-event-per-request — decision 5)
// ---------------------------------------------------------------------------

/**
 * Fireflies webhook body shape. The PoC does not yet ingest
 * Fireflies via webhook (transcripts are dropped to Drive
 * today), so this shape mirrors the planner's prescription +
 * Fireflies-public webhook docs for `Transcription Completed`
 * events. The required fields are validated; unknown fields
 * are tolerated so a future API version doesn't break the
 * adapter.
 */
interface RawFirefliesWebhookBody {
  /** Fireflies meeting id — combined into the synthetic
   *  eventId. */
  readonly meetingId?: string;
  /** Per-revision id (decision 4 — falls back to `transcriptId`
   *  if absent). Don't throw when missing. */
  readonly revision?: string;
  /** The completed transcription's id — used as eventId
   *  fallback when `revision` is absent. */
  readonly transcriptId?: string;
  /** Event type — typically `'Transcription Completed'`. */
  readonly action?: string;
  /** Meeting title — used by `meetingTitleAllowlist`. */
  readonly title?: string;
  /** The full transcript bytes — speakers + timestamps +
   *  metadata preserved verbatim per orchestrator override 6. */
  readonly transcript?: string;
  /** Optional ISO timestamp of when the transcription
   *  completed. Fireflies typically sends this. */
  readonly completedAt?: string;
  /** Forward-compatible: any additional metadata Fireflies
   *  sends. Pass through verbatim in contentBytes. */
  readonly [key: string]: unknown;
}

export function extractFirefliesSignature(
  headers: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (
      k.toLowerCase() === FIREFLIES_SIGNATURE_HEADER &&
      typeof v === "string"
    ) {
      return v;
    }
  }
  return undefined;
}

/**
 * Build a deterministic event id from `(meetingId, revision OR
 * transcriptId, action)`. Fireflies doesn't ship a per-event
 * gid, but the combination above is stable across replays
 * AND distinguishes per-revision events on the same meeting.
 *
 * Decision 4: when `revision` is absent, fall back to
 * `transcriptId` rather than throwing — this is a better-
 * degraded behavior because Fireflies' webhook may not always
 * include `revision` in older API versions.
 */
function deriveEventId(body: RawFirefliesWebhookBody): string {
  const revOrTx = body.revision ?? body.transcriptId ?? "";
  const parts = [body.meetingId ?? "", revOrTx, body.action ?? ""].join("|");
  return createHash("sha256").update(parts).digest("hex").slice(0, 32);
}

function parseFirefliesWebhookBody(body: Buffer): RawFirefliesWebhookBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch (err) {
    throw new ValidationError(
      `fireflies webhook: body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(
      "fireflies webhook: body root must be a JSON object (single-event envelope)",
    );
  }
  return parsed as RawFirefliesWebhookBody;
}

function matchesAllowlist(
  title: string,
  allowlist: readonly string[],
): boolean {
  if (allowlist.length === 0) return true;
  const lower = title.toLowerCase();
  for (const entry of allowlist) {
    if (lower.includes(entry.toLowerCase())) return true;
  }
  return false;
}

export interface BuildFirefliesWebhookHelpersArgs {
  /** Operator scope filter. Defaults to `[]` (ingest all). */
  readonly meetingTitleAllowlist?: readonly string[];
}

export function buildFirefliesWebhookHelpers(
  args: BuildFirefliesWebhookHelpersArgs = {},
): SourceWebhookHelpers {
  const allowlist = args.meetingTitleAllowlist ?? [];
  const verifier: WebhookVerifier = new HmacSha256Verifier();
  return {
    verifier,
    extractSignature: extractFirefliesSignature,
    parseEvents: ({ body, fetchedAt }) => {
      const parsed = parseFirefliesWebhookBody(body);

      const meetingId = parsed.meetingId;
      const action = parsed.action;
      const transcript = parsed.transcript;
      const title = parsed.title;
      if (
        typeof meetingId !== "string" ||
        meetingId.length === 0 ||
        typeof action !== "string" ||
        action.length === 0 ||
        typeof transcript !== "string" ||
        typeof title !== "string"
      ) {
        throw new ValidationError(
          "fireflies webhook: event missing required fields (meetingId, action, transcript, title)",
        );
      }

      // Operator scope filter — applies BEFORE we enqueue.
      // Dropped meetings never produce a webhook_events row.
      if (!matchesAllowlist(title, allowlist)) return [];

      const eventId = deriveEventId(parsed);
      // sourceDocId = meetingId (decision 10 — all revisions of
      // the same meeting share the audit prefix). The
      // sourceRevision below is the per-event eventId so a
      // revised transcript surfaces as a fresh intake row.
      const sourceDocId = meetingId;
      const at = fetchedAt ?? new Date();

      // contentBytes encodes the FULL body verbatim — speakers,
      // timestamps, metadata, transcript text. The
      // Compilation Worker has everything; spotlight-wrapping
      // happens at the LLM-call edge (orchestrator override 6).
      const contentBytes = Buffer.from(JSON.stringify(parsed), "utf8");
      if (contentBytes.length > ONE_MIB) {
        throw new ValidationError(
          `fireflies webhook: event exceeds 1 MiB ceiling (got ${contentBytes.length} bytes)`,
        );
      }

      const out: SourceWebhookEvent[] = [
        {
          eventId,
          doc: {
            sourceDocId,
            sourceRevision: eventId,
            sourceRef: `fireflies:meeting/${meetingId}`,
            fetchedAt: at,
            contentBytes,
          },
        },
      ];
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateFirefliesSourceAdapterArgs {
  readonly credentialStore: CredentialStore;
  readonly credentialId: CredentialId;
  readonly config: FirefliesBindingConfig | unknown;
}

export function createFirefliesSourceAdapter(
  args: CreateFirefliesSourceAdapterArgs,
): SourceAdapter {
  const config = firefliesBindingConfigSchema.parse(args.config);

  // credentialStore + credentialId are part of the factory shape
  // (THREAT-MODEL §3.6 invariant 11) but unused by webhook-mode
  // adapters: the engine-ingestion receiver resolves the actual
  // webhook secret via `config.webhookSecretCredentialId` at
  // verify-time, not through these args.
  void args.credentialStore;
  void args.credentialId;

  const helpers = buildFirefliesWebhookHelpers({
    meetingTitleAllowlist: config.meetingTitleAllowlist,
  });

  return {
    slug: FIREFLIES_ADAPTER_SLUG,
    async scan(scanArgs: SourceScanArgs): Promise<SourceScanResult> {
      void scanArgs;
      return { documents: [], nextCursor: null };
    },
    webhook: helpers,
  };
}
