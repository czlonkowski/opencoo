/**
 * Asana SourceAdapter — webhook mode (PR 24 / plan #115).
 *
 * Asana sources events via webhooks (the PoC's pattern). The
 * adapter exposes:
 *   - `slug: 'asana'`
 *   - `scan()` — returns `{ documents: [], nextCursor: null }`.
 *     Webhook adapters do NOT scan; the receiver pushes events
 *     in. We satisfy the port shape so a degenerate Scanner
 *     run is a no-op.
 *   - `webhook.verifier` — HMAC-SHA256 over the raw body
 *     (Asana sends `X-Hook-Signature` as hex).
 *   - `webhook.extractSignature(headers)` — looks up
 *     `x-hook-signature` (case-insensitive).
 *   - `webhook.parseEvents({ body })` — unpacks the Asana
 *     webhook envelope `{ events: [...] }`. Each event becomes
 *     one `SourceWebhookEvent` with a stable `eventId`
 *     derived from `(event.user, event.created_at,
 *     event.resource.gid)` — Asana doesn't expose a per-event
 *     id directly, so we compute a deterministic hash.
 *
 * # Architecture pin
 *
 * Per orchestrator override 5: HMAC verification stays in the
 * engine-ingestion receiver. This adapter EXPORTS the verifier;
 * it does NOT verify on its own (no req/res abstraction
 * dependency, keeps the package dependency-light). The
 * receiver's responsibilities:
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

import {
  asanaBindingConfigSchema,
  type AsanaBindingConfig,
} from "./binding-config.js";

export const ASANA_ADAPTER_SLUG = "asana" as const;

/** Header Asana sends signatures on. Case-insensitive lookup
 *  via the helper below. */
export const ASANA_SIGNATURE_HEADER = "x-hook-signature";

export interface CreateAsanaSourceAdapterArgs {
  readonly credentialStore: CredentialStore;
  readonly credentialId: CredentialId;
  readonly config: AsanaBindingConfig | unknown;
}

/**
 * Internal Asana webhook event shape — derived from the
 * payload Asana POSTs. The PoC's docs describe the same
 * shape.
 */
interface RawAsanaEvent {
  /** ISO timestamp; combined into the synthetic eventId. */
  readonly created_at?: string;
  /** Actor user gid; combined into the synthetic eventId. */
  readonly user?: { readonly gid?: string };
  /** Resource the event is about (task, project, etc.). */
  readonly resource?: {
    readonly gid?: string;
    readonly resource_type?: string;
  };
  readonly action?: string;
  readonly change?: { readonly field?: string };
}

interface RawAsanaWebhookBody {
  readonly events?: ReadonlyArray<RawAsanaEvent>;
}

export function extractAsanaSignature(
  headers: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === ASANA_SIGNATURE_HEADER && typeof v === "string") {
      return v;
    }
  }
  return undefined;
}

/**
 * Build a deterministic event id from `(user, created_at,
 * resource.gid, action)`. Asana doesn't ship a per-event gid,
 * but the combination above is stable across replays.
 */
function deriveEventId(event: RawAsanaEvent): string {
  const parts = [
    event.user?.gid ?? "",
    event.created_at ?? "",
    event.resource?.gid ?? "",
    event.action ?? "",
    event.change?.field ?? "",
  ].join("|");
  return createHash("sha256").update(parts).digest("hex").slice(0, 32);
}

function parseAsanaWebhookBody(body: Buffer): RawAsanaWebhookBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch (err) {
    // ValidationError so the receiver classifies as
    // errorClass='validation' (THREAT-MODEL §3.1) — body-shape
    // failures are not retried.
    throw new ValidationError(
      `asana webhook: body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ValidationError("asana webhook: body root must be a JSON object");
  }
  // Coerce shape-checked but not strictly typed.
  return parsed as RawAsanaWebhookBody;
}

export function buildAsanaWebhookHelpers(): SourceWebhookHelpers {
  const verifier: WebhookVerifier = new HmacSha256Verifier();
  return {
    verifier,
    extractSignature: extractAsanaSignature,
    parseEvents: ({ body, fetchedAt }) => {
      const parsed = parseAsanaWebhookBody(body);
      const events = parsed.events ?? [];
      const at = fetchedAt ?? new Date();
      const out: SourceWebhookEvent[] = [];
      for (const ev of events) {
        // Validate required fields BEFORE deriving an eventId —
        // empty resource.gid + empty action would still hash to
        // a stable id, but the resulting sourceDocId would be
        // ambiguous and intake-dedupe would conflate distinct
        // events. Fail closed with errorClass='validation'.
        const resourceGid = ev.resource?.gid;
        const resourceType = ev.resource?.resource_type;
        const action = ev.action;
        if (
          typeof resourceGid !== "string" ||
          resourceGid.length === 0 ||
          typeof resourceType !== "string" ||
          resourceType.length === 0 ||
          typeof action !== "string" ||
          action.length === 0
        ) {
          throw new ValidationError(
            "asana webhook: event missing required fields (resource.gid, resource.resource_type, action)",
          );
        }
        const eventId = deriveEventId(ev);
        const sourceDocId = `${resourceGid}:${action}`;
        const contentBytes = Buffer.from(JSON.stringify(ev), "utf8");
        // 1 MiB ceiling mirrors the SourceAdapter contract; an
        // event that serializes larger fails closed rather than
        // overflowing the Compilation Worker prompt budget.
        if (contentBytes.length > 1024 * 1024) {
          throw new ValidationError(
            `asana webhook: event exceeds 1 MiB ceiling (got ${contentBytes.length} bytes)`,
          );
        }
        out.push({
          eventId,
          doc: {
            sourceDocId,
            sourceRevision: eventId, // every event = new revision
            sourceRef: `asana:${resourceType}/${resourceGid}`,
            fetchedAt: at,
            // Inline the event JSON as bytes so the
            // Compilation Worker has the full event verbatim.
            contentBytes,
          },
        });
      }
      return out;
    },
  };
}

export function createAsanaSourceAdapter(
  args: CreateAsanaSourceAdapterArgs,
): SourceAdapter {
  // Validate the config at factory time — fail loud here.
  asanaBindingConfigSchema.parse(args.config);
  // credentialStore + credentialId are part of the factory shape
  // (THREAT-MODEL §3.6 invariant 11) but unused by webhook-mode
  // adapters: the engine-ingestion receiver resolves the actual
  // webhook secret via `config.webhookSecretCredentialId` at
  // verify-time, not through these args.
  void args.credentialStore;
  void args.credentialId;

  return {
    slug: ASANA_ADAPTER_SLUG,
    async scan(_args: SourceScanArgs): Promise<SourceScanResult> {
      // Webhook adapters don't scan. The receiver pushes events
      // in directly. A degenerate Scanner run reports 0 docs
      // and a null cursor.
      void _args;
      return { documents: [], nextCursor: null };
    },
    webhook: buildAsanaWebhookHelpers(),
  };
}
