# @opencoo/source-asana

SourceAdapter for Asana (webhook mode). Implements `SourceAdapter` from `@opencoo/shared/source-adapter` with the optional `webhook` helpers (`verifier` + `extractSignature` + `parseEvents`).

## Architecture

Asana sources events via webhooks; the adapter does NOT poll. The engine-ingestion webhook receiver (`POST /webhooks/asana`) consumes the adapter's helpers:

1. Resolve the binding (by webhook target URL or path id).
2. Resolve the binding's `webhookSecretCredentialId` to secret bytes via the `CredentialStore`.
3. Read the request body (raw bytes) and headers.
4. Call `adapter.webhook.verifier.verify({ body, secret, signature })` where `signature` came from `adapter.webhook.extractSignature(headers)`.
5. On `ok: false` → throw `WebhookSignatureError(validation)` (DLQ; no replay).
6. On `ok: true` → call `adapter.webhook.parseEvents({ body })` to unpack events.
7. For each event, dedupe `eventId` against the `webhook_events` UNIQUE constraint on `(binding_id, event_id)`, then push into intake.

The adapter's `scan()` method is a no-op (`{ documents: [], nextCursor: null }`) for protocol parity with polling adapters.

## Webhook setup handshake (deferred to PR 30)

Asana's webhook setup protocol requires an `X-Hook-Secret` echo on the first POST:

1. Operator registers a webhook on an Asana project via `POST /webhooks` with the receiver's URL.
2. Asana sends the first request with an empty body and an `X-Hook-Secret: <random>` header.
3. The receiver MUST echo `X-Hook-Secret` back in the response headers AND persist the secret value as the binding's `webhookSecretCredentialId` (writing to the `CredentialStore`).
4. From the second request onward, Asana signs each request body with `X-Hook-Signature: <hex>` (HMAC-SHA256 over the raw body, using the secret from step 2).

The handshake endpoint lives in `engine-ingestion`'s webhook receiver at PR 30 — this package only ships the verification helpers.

## Configuration

```ts
{
  projectGid: "1214005588882595",
  workspaceGid: "11092903687429",        // optional
  webhookSecretCredentialId: "<uuid>",
  reviewMode: "auto",                      // or "review"
}
```

`reviewMode: "auto"` requires the redaction guard (PR 12 GuardAdapter) wired into the ingestion path — Asana task bodies are untrusted.

## Tests

- `pnpm test` — runs the shared `sourceAdapterContract` (webhook mode) + adapter-specific assertions.
- `pnpm test:contract` — the contract suite alone.
