# @opencoo/source-asana

SourceAdapter for Asana (webhook mode). Implements `SourceAdapter` from `@opencoo/shared/source-adapter` with the optional `webhook` helpers (`verifier` + `extractSignature` + `handshakeFn` + `parseEvents`).

## Architecture

Asana sources events via webhooks; the adapter does NOT poll. The engine-ingestion webhook receiver (`POST /webhooks/:bindingId`) consumes the adapter's helpers:

0. **Handshake (PR-F):** receiver calls `adapter.webhook.handshakeFn(headers)` BEFORE signature verification. If it returns a `HandshakeResult` (x-hook-secret header present), the receiver echoes the secret, persists it to CredentialStore, and returns 200 without enqueueing.
1. Resolve the binding (by webhook target URL or path id).
2. Resolve the binding's `webhookSecretCredentialsId` to secret bytes via the `CredentialStore`.
3. Read the request body (raw bytes) and headers.
4. Call `adapter.webhook.verifier.verify({ body, secret, signature })` where `signature` came from `adapter.webhook.extractSignature(headers)`.
5. On `ok: false` → throw `WebhookSignatureError(validation)` (DLQ; no replay).
6. On `ok: true` → call `adapter.webhook.parseEvents({ body })` to unpack events.
7. `parseEvents` filters events: derives `eventType` via `deriveEventType`, drops null events (noise), applies `monitoredProjectGids` filter (if set), and emits `SourceWebhookEvent` with `eventType` set.
8. For each event, dedupe `eventId` against the `webhook_events` UNIQUE constraint on `(binding_id, event_id)`, then push into intake.

The adapter's `scan()` method is a no-op (`{ documents: [], nextCursor: null }`) for protocol parity with polling adapters.

## Webhook setup handshake

Asana's webhook setup protocol requires an `X-Hook-Secret` echo on the first POST:

1. Operator registers a webhook on an Asana project via `POST /webhooks` with the receiver's URL.
2. Asana sends the first request with an empty body and an `X-Hook-Secret: <random>` header.
3. The receiver (via `handshakeFn`) echoes `X-Hook-Secret` back in the response headers AND persists the secret value to the `CredentialStore`, updating `sources_bindings.webhook_secret_credentials_id`.
4. From the second request onward, Asana signs each request body with `X-Hook-Signature: <hex>` (HMAC-SHA256 over the raw body, using the secret from step 2).

The `handshakeFn` is exported by this package and called by the engine-ingestion webhook receiver before signature verification.

## Event-type derivation (PR-F)

`parseEvents` derives a 6-element `EventType` from each raw Asana event payload:

| `eventType`        | Condition                                                                   |
|--------------------|-----------------------------------------------------------------------------|
| `created`          | `action:added` + `resource.resource_type:task`                              |
| `completed`        | `action:changed` + `change.field:completed`                                 |
| `commented`        | `action:added` + `resource.resource_type:story` + `parent.resource_type:task` |
| `assignee_changed` | `action:changed` + `change.field:assignee`                                  |
| `due_date_changed` | `action:changed` + `change.field:due_on`                                    |
| `updated`          | `action:changed` + `change.field ∈ {name, notes, memberships}`              |
| null (dropped)     | Deletions, removals, story on non-task parent, uninteresting field changes  |

Events with `eventType = null` are silently dropped before emitting `SourceWebhookEvent`.

## Monitored-project filter (PR-F)

When `monitoredProjectGids` is set in the binding config, events for projects NOT in the allowlist are silently dropped. Default (undefined) = all projects pass (backwards-compatible).

## Light-tier per-event summary (PR-F)

When `lightSummaryEnabled: true` in the binding config, each qualifying event gets a Light-tier LLM call to produce a ≤25-word Polish one-liner summary, attached as `metadata.summary` on the `SourceEvent`. The summary helper (`summarizeAsanaEvent` in `light-summary.ts`) wraps event content in `<source_content>` tags (THREAT-MODEL §3.4 XML spotlighting). Failures are non-fatal: the event is still emitted without `metadata.summary`.

## Configuration

```ts
{
  projectGid: "1214005588882595",
  workspaceGid: "11092903687429",        // optional
  webhookSecretCredentialId: "<uuid>",   // set after handshake
  reviewMode: "auto",                    // or "review"
  monitoredProjectGids: ["1214005588882595"],  // optional allowlist
  lightSummaryEnabled: false,            // opt-in to Light-tier summaries
}
```

`reviewMode: "auto"` requires the redaction guard (PR 12 GuardAdapter) wired into the ingestion path — Asana task bodies are untrusted.

## Tests

- `pnpm test` — runs the shared `sourceAdapterContract` (webhook mode) + adapter-specific assertions (stub mode, no real LLM).
- `pnpm test:contract` — the contract suite alone.
- `RUN_REAL_LLM=1 pnpm test src/light-summary.real-llm.test.ts` — real LLM integration test against OpenRouter (requires `OPENROUTER_API_KEY`).
