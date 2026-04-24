# @opencoo/guard-redaction-regex

Regex-based `GuardAdapter` (role: `redaction`). The first concrete guard implementation under the v0.1 GuardAdapter port. Pure-function `classify`; no DB writes — the engine is the layer that persists `redaction_events` rows (CONVENTIONS §4.1, THREAT-MODEL §3.3).

Implements the `GuardAdapter` port from `@opencoo/shared/adapter-contract-tests/guard` and is verified by the 12-assertion `guardAdapterContract` (one suite, every guard backend; drift in any one breaks all).

## What this guard catches (v1 catalog — 14 categories)

PII identifiers:

| Category | Validator |
| --- | --- |
| `email` | shape only (RFC-light, bounded local/domain/TLD) |
| `phone-pl` | shape + digit-count check (Polish national format, +48 / 0048 / 48 prefix optional) |
| `phone-international` | E.164 shape only |
| `pesel` | weighted-sum checksum (11-digit Polish national ID) |
| `nip` | weighted-sum checksum (10-digit Polish tax ID) |
| `regon` | weighted-sum checksum (9- and 14-digit Polish company ID) |

Financial:

| Category | Validator |
| --- | --- |
| `iban` | MOD-97 over rearranged alphanumerics (BigInt, ISO 13616) |
| `credit-card` | Luhn checksum, 13-19 digits |

Secret-token shapes:

| Category | Validator |
| --- | --- |
| `aws-access-key` | shape only (`AKIA[0-9A-Z]{16}`) |
| `aws-secret-key` | anchored on `aws_secret_*` literal + 40-char base64-ish run |
| `private-key-block` | matches `-----BEGIN <KIND> PRIVATE KEY-----` header line |
| `slack-token` | bounded `xox[abps]-…` shape |
| `github-token` | bounded `gh[pousr]_…` shape |
| `bearer-token` | `Bearer <40-200 alnum/._~+/-/=>` |

> **Polish-PII bias.** The design-partner PoC validating the product is a Polish company, so PESEL/NIP/REGON ship in v1. The same architecture supports EU-wide and US identifiers; v0.2 will add SSN, NHS number, Steuer-ID, and similar with the same shape (regex + optional checksum + per-category `failMode`). The contract suite is locale-agnostic — adding categories does not change the port.

## Usage

```ts
import { guardRedactionRegex } from "@opencoo/guard-redaction-regex";

const guard = guardRedactionRegex();

const result = await guard.classify({
  text: "Email me at foo@example.test about PESEL 44051401359.",
});

// result.events:
//   [
//     { category: 'email', patternVersion: 'v1.2026-04-25',
//       matchedByteRanges: [{ start: 12, end: 28 }], failMode: 'transform' },
//     { category: 'pesel', patternVersion: 'v1.2026-04-25',
//       matchedByteRanges: [{ start: 41, end: 52 }], failMode: 'transform' },
//   ]
//
// result.transformedText:
//   "Email me at [REDACTED:email] about PESEL [REDACTED:pesel]."
```

`classify()` is async by port contract (future LLM-backed guards need it); the regex implementation resolves synchronously on the next tick.

## Pattern version

`PATTERN_VERSION = 'v1.2026-04-25'` — every emitted `GuardEvent` carries this string. The format is sortable (`vN.YYYY-MM-DD`) so audit-log scans (`WHERE pattern_version >= 'v1.2026-04-25'`) are linear. Plain semver loses the date signal that operators want when triaging "did this match shape exist when this row was written?".

Bumping rules:
- Add a category → bump the date suffix (still v1).
- Tighten an existing pattern in a way that can change which substrings match → bump to `v2.YYYY-MM-DD`.
- Reword the regex but keep matches identical → don't bump.

## Threat-model invariants

1. **Metadata-only events** (THREAT-MODEL §3.3). `GuardEvent` carries `category`, `patternVersion`, `matchedByteRanges`, `failMode`. **No content** surface — the matched substring NEVER appears in any field. The contract suite's `metadata-only invariant` assertion passes a sentinel substring inside each known sample and checks `JSON.stringify(events)` does not contain it. Adding `matched: string` to events would fail this test — that's the design.
2. **Stateless**. Each `classify()` builds its own byte-offset map and clones each `RegExp` from the frozen `as const` catalog, so two parallel callers cannot interfere via `lastIndex` mutation. No cache, no shared state across calls.
3. **Idempotent transform**. `[REDACTED:<category>]` tokens do not match any v1 pattern, so re-classifying the transformed text yields zero new events for the same category. The contract suite's idempotence assertion locks this — anti-loop guarantee for the engine.
4. **ReDoS protection.** Every regex uses bounded quantifiers — no unbounded `+`/`*`, no nested groups with overlapping quantifiers. The 100KiB perf canary in the test suite asserts a hostile mixed-PII blob classifies in <500ms (it consistently runs in ~3ms locally; the budget is generous to absorb CI noise).

## Engine-side wiring

The adapter does NOT persist events. Engine wiring (PR 15+) looks like:

```ts
const r = await guard.classify({ text });
for (const event of r.events) {
  await db.insert(redactionEvents).values({
    pipeline: "ingestion.compiler",
    domainId,
    bindingId,
    guardSlug: guard.slug,
    category: event.category,
    patternVersion: event.patternVersion,
    matchedByteRanges: [...event.matchedByteRanges],
    failMode: event.failMode,
  });
}
// then forward r.transformedText to the next pipeline stage
```

`pipeline`, `domainId`, `bindingId` live at the call site (Correction A from PR 12) — the adapter is a leaf and never knows its caller's context.

## Testing

```bash
pnpm --filter @opencoo/guard-redaction-regex test
```

The test file invokes the shared `guardAdapterContract` with thirteen known-good positive samples — one per category in the v1 catalog except `phone-international` (its E.164 shape collides with `phone-pl` under the longest-match-wins overlap policy, so it's exercised by being the leftmost match in compound texts rather than as a standalone known-match). Then it runs adapter-specific cases for:

- `PATTERN_VERSION` constant
- `[REDACTED:<category>]` transform token shape
- PESEL / Luhn / IBAN MOD-97 checksum-validator rejection of false positives
- Every `PATTERNS` regex uses bounded quantifiers (structural ReDoS check)
- `_resolveOverlap` longest-match-wins policy (3 unit tests)
- 100KiB hostile-blob perf canary (<500ms)
- 100KiB metadata-only sentinel scan

## What this package does NOT do

- It does NOT classify injection attempts or content-safety violations. Those are separate `GuardAdapter` implementations with `role: 'injection'` / `role: 'content_safety'` — same port, different categories.
- It does NOT mutate any state outside the returned `GuardClassifyResult`.
- It does NOT write `redaction_events` rows. The engine does (CONVENTIONS §4.1).
- It does NOT call out to a sidecar or the network. Pure-function classify; no I/O beyond reading the input string.
