# @opencoo/source-fireflies

`SourceAdapter` for Fireflies meeting transcripts (webhook mode).
Implements `SourceAdapter` from `@opencoo/shared` with the standard
webhook-mode helpers — `verifier` + `extractSignature` + `parseEvents`.
Mirrors the [`@opencoo/source-asana`](../source-asana) shape: a single
`adapter.ts` module holds the binding-config schema, factory, and
parser; `src/testing/` ships a deterministic mock fixture for the
shared `sourceAdapterContract` suite.

## Status

- v0.1 (PR 27 / plan #126). Use-case-tier tests only — no Docker, no
  network.
- The PoC currently ingests Fireflies transcripts via Drive
  (`source-drive`); this adapter is the forward-looking direct webhook
  path. `architecture.md` §17 Open questions "Fireflies webhook vs
  Drive polling" — webhook adapter ships first; polling deferred until
  customer demand.

## Public surface

```ts
import {
  FIREFLIES_ADAPTER_SLUG,
  FIREFLIES_SIGNATURE_HEADER,
  buildFirefliesWebhookHelpers,
  createFirefliesSourceAdapter,
  extractFirefliesSignature,
  firefliesBindingConfigSchema,
} from "@opencoo/source-fireflies";
```

- `createFirefliesSourceAdapter({credentialStore, credentialId,
   config})` — adapter factory. The factory shape pins
   THREAT-MODEL §3.6 invariant 11: credentials by id, never inline.
   Webhook adapters don't use `credentialStore` / `credentialId`
   directly — the receiver resolves the per-binding webhook secret
   via `config.webhookSecretCredentialId`.
- `firefliesBindingConfigSchema` — Zod schema for the binding's
  `config` JSONB. Required: `webhookSecretCredentialId`. Optional:
  `reviewMode` (default `'approve'`), `meetingTitleAllowlist`
  (default `[]`).
- `buildFirefliesWebhookHelpers({meetingTitleAllowlist?})` — the
  three-helper bundle the engine-ingestion webhook receiver
  composes: `verifier` (HMAC-SHA256 reusing
  `@opencoo/shared/webhook-verifier`), `extractSignature`
  (case-insensitive `x-fireflies-signature` lookup), `parseEvents`
  (single-event envelope; allowlist filter; verbatim contentBytes).

## Binding-config

```jsonc
{
  "webhookSecretCredentialId": "<uuid of webhook secret in CredentialStore>",
  "reviewMode": "approve",
  "meetingTitleAllowlist": ["weekly", "quarterly"]
}
```

### `reviewMode` — column-vs-jsonb sovereignty

The runtime source of truth is the `sources_bindings.review_mode`
COLUMN, not this jsonb field. The Management UI / migration path uses
this jsonb default at binding-creation time to seed the column;
thereafter the engine reads the column.

Default = `'approve'` because the PoC's pattern (THREAT-MODEL §3.1) is
that meeting transcripts ship review-required — they often contain
unredacted PII and the operator decides per-meeting whether to
ingest. Operators with a clean meeting culture can switch to
`'auto'`.

The full enum is `auto | approve | review` (matches the column).
NOTE: source-asana's binding-config currently misses `'approve'` from
its enum — that's a residual advisory tracked for v0.2.

### `meetingTitleAllowlist` — operator scope filter

Default `[]` (empty array = ingest every meeting). When non-empty,
each entry is matched **case-insensitively as a substring** against
the meeting title. The check runs in `parseEvents` BEFORE the event
is enqueued, so dropped meetings never produce a `webhook_events`
row. Useful for operators who want only specific meeting series
ingested.

## Webhook envelope

**Note (forward-looking):** the PoC ingests Fireflies via Drive today,
so this envelope shape mirrors Fireflies' public webhook docs +
the planner's prescription rather than direct PoC observation.
When partner traffic actually starts arriving, pin the field names
and types against a captured production payload — adjust here if the
real envelope differs.

Single-event-per-request:

```jsonc
{
  "meetingId": "meeting-123",
  "transcriptId": "transcript-123-1",
  "revision": "rev-1",
  "action": "Transcription Completed",
  "title": "Daily Standup",
  "transcript": "Alice 00:00:01: Hello team.\n…",
  "completedAt": "2026-04-25T12:00:00.000Z"
}
```

- **Required fields:** `meetingId`, `action`, `transcript`, `title`.
  Missing → `ValidationError` (the receiver classifies as
  `errorClass: 'validation'`; not retried).
- **`revision` fallback:** when absent, the eventId is derived from
  `transcriptId` instead. Don't throw — better-degraded behavior
  because older Fireflies API versions may not always include
  `revision`.
- **Single-event envelope:** `parseEvents` returns an array of length
  0 (filtered by `meetingTitleAllowlist`) or 1.
- **`sourceRef` format:** `fireflies:meeting/<meetingId>` — meetingId
  only, NOT transcriptId. All revisions of the same meeting share
  the audit-grep prefix.
- **`sourceDocId`:** `meetingId` (revisions of the same meeting share
  an intake key prefix).
- **`sourceRevision`:** the per-event eventId (sha256 of
  `(meetingId|revision OR transcriptId|action)`, sliced to 32 hex
  chars).

## Signature header

`X-Fireflies-Signature` (case-insensitive lookup). HMAC-SHA256 over
the raw body. The verifier is
`@opencoo/shared/webhook-verifier#HmacSha256Verifier` — NO
re-implementation; the package gets HMAC for free.

**Note (forward-looking):** the header name above is the planner's
prescription against Fireflies' public webhook docs. The PoC has no
direct Fireflies webhook today; when partner traffic arrives, confirm
the actual header against a real signed request and pin if Fireflies
ships a different name (e.g. `X-Hub-Signature` style).

## Architectural pins

- **Spotlight wrapping happens at the LLM-call edge (PR 15)**, NOT at
  intake. The adapter faithfully encodes the source bytes verbatim —
  speakers, timestamps, metadata, transcript text. Defense lives one
  layer up.
- **HMAC verification stays in the engine-ingestion receiver.** The
  adapter EXPORTS the verifier; it does NOT verify on its own (no
  req/res abstraction dependency, keeps the package dependency-light).
  Receiver flow: resolve `webhookSecretCredentialId` → secret bytes →
  `verifier.verify({ body, secret, signature })` → on `ok:false`
  throw `WebhookSignatureError(validation)` → on `ok:true`
  `parseEvents({ body })` → dedupe `eventId` against `webhook_events`
  UNIQUE (binding_id, event_id) → push into intake.
- **1 MiB ceiling on contentBytes** — mirrors the SourceAdapter
  contract assertion 7. A transcript that serializes larger fails
  closed rather than overflowing the Compilation Worker prompt
  budget.

## Tests

```sh
pnpm --filter @opencoo/source-fireflies test            # 35 tests
pnpm --filter @opencoo/source-fireflies test:contract   # shared webhook contract suite
```

Use-case tier only. The mock fixture at
`src/testing/mock-fireflies-events.ts` produces a realistic
single-event body + a valid HMAC-SHA256 signature against a test
secret, and exposes the canonical `headers` bag the receiver would
see in production.
