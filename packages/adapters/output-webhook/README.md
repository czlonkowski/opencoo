# `@opencoo/output-webhook`

Generic webhook `OutputAdapter` — delivers opencoo payloads to any external HTTP receiver.

## What it does

- POST JSON payloads to a configurable `targetUrl`.
- Signs every outgoing request with HMAC-SHA256: `X-OpenCoo-Signature: <64-hex>`.
- Attaches `X-OpenCoo-Delivery-Id: <uuid>` for receiver-side idempotency — deterministic from `(bindingId, payloadHash)`.
- Exponential backoff with jitter on transient (5xx) failures: `delay = baseDelayMs * 2^attempt + random(0, 250ms)`.
- Appends one `output_deliveries` audit row per attempt (INSERT-only, no UPDATE — append-only invariant).
- On terminal failure: final row `status='dlq'`, optional `onDlq` callback fires for the Activity tab alert surface.

## Binding config

```ts
{
  targetUrl: "https://example.com/hooks/opencoo",
  signingSecretCredentialId: "<credential UUID>",  // CredentialStore ID, never raw bytes
  retryPolicy: {
    maxAttempts: 5,   // default
    baseDelayMs: 500, // default
  },
  headers: {
    "X-Custom-Header": "value",
    // "Authorization": FORBIDDEN — use signingSecretCredentialId
  },
}
```

The `Authorization` header is **rejected at config-validate time** (case-insensitive). Credentials route through `signingSecretCredentialId` only. See THREAT-MODEL §3.6 invariant 11.

## Outgoing request format

```
POST <targetUrl> HTTP/1.1
Content-Type: application/json
x-opencoo-signature: <64-hex HMAC-SHA256 over raw body bytes>
x-opencoo-delivery-id: <UUID v5 deterministic from bindingId + payloadHash>
[operator-configured headers]

{"event":"heartbeat.report","data":{...}}
```

## Payload schema

```ts
{
  event: string,   // e.g. "heartbeat.report", "lint.finding"
  data: Record<string, unknown>,
}
```

Schema is `.strict()` — extra keys fail validation before any HTTP call.

## `output_deliveries` table

Append-only audit (THREAT-MODEL §2 invariant 8). Schema: `packages/shared/src/db/schema/output-deliveries.ts`. Migration: `packages/shared/drizzle/0009_windy_king_bedlam.sql`.

Each attempt = one row with fixed `status ∈ {success, transient_failure, dlq}` at insert time. Natural key: `(output_binding_id, delivery_id, attempt)`.

## Reader-agent ADR

> Heartbeat, Lint, and Chat are reader-only agents (THREAT-MODEL §2.6 reader-vs-writer invariant). They MAY trigger output-webhook because Output is NOT a wikiWrite path — it's a notification surface. The append-only invariant on `output_deliveries` table preserves audit history.

## THREAT-MODEL coverage

- **§3.6 invariant 11** (no credential bytes in errors/payloads): signing secret resolved from CredentialStore only; never serialized into body, headers, or error messages.
- **§2 invariant 8** (append-only): INSERT-per-attempt; no UPDATE on `output_deliveries` rows.
- **§3.13** (server-side authorization): binding creation goes through `POST /api/admin/output-bindings` (future) with `verifyAdmin` + CSRF.

## Activity tab alert surface (PR-B concern)

The `onDlq` callback in `createWebhookOutputAdapter` fires on terminal failure with `{ deliveryId, error }`. PR-B's Activity SSE bus will wire this callback when it ships. Until then, the callback is optional and the DLQ row in `output_deliveries` is the persistent audit record.

**DONE_WITH_CONCERNS: Activity tab wiring** — The `onDlq` callback interface is ready; wiring to PR-B's SSE bus (`/api/admin/events`) is deferred until PR-B ships its `QueueEvents` listener pattern. Flag for PR-B implementer: look for `onDlq` in `createWebhookOutputAdapter` args.
