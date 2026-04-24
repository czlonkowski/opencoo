# @opencoo/shared

Shared kernel for the opencoo monorepo.

## Schema ownership

**This package is the single source of truth for every `pgTable` in the monorepo.** No other package declares database tables (CLAUDE.md "load-bearing architectural decisions"). Engines, adapters, CLI, and UI all import schema from `@opencoo/shared/db/schema`.

### Adding a table

1. Create `src/db/schema/<new-table>.ts` with the `pgTable` declaration.
2. Append `export * from "./<new-table>.js";` to `src/db/schema/index.ts`. Keep this list alphabetized — drizzle's schema glob reads files in alphabetical order, and FK targets must appear before FK sources (e.g. `credentials.ts` before `sources-bindings.ts`).
3. Add a matching block to `tests/schema.test.ts` — column names, SQL types, nullability, defaults, FK targets, indexes.
4. Run `pnpm --filter @opencoo/shared test` → Red. Then run `pnpm --filter @opencoo/shared db:generate --name <short-label>` to produce the migration.
5. Re-run tests → Green; commit in test-before-impl order.

### Adding a column to an existing table

Extend the `pgTable` body, add/update tests, then `db:generate --name <label>`. Never hand-edit existing `drizzle/*.sql` files — always generate.

### Adding a value to a `pgEnum`

Cheap migration. Append to the `pgEnum(...)` tuple and generate. **Renaming** an enum value (or the enum itself) is expensive — it requires an explicit `ALTER TYPE` that the Drizzle differ won't emit. Plan renames as a dedicated PR.

## Identity

### Server-generated UUIDs

Every table uses `uuid("id").primaryKey().default(sql\`gen_random_uuid()\`)`. `gen_random_uuid()` is in PostgreSQL core since **PG 13** — the reference docker image pins PG 16, so no `CREATE EXTENSION pgcrypto` line is required. **Write paths must not specify `id`** unless rotating a credential or recreating a purged row; let the DB generate it.

### Branded ID types

```ts
import type { DomainId, SourceBindingId, UserId, CredentialId } from "@opencoo/shared/db";
```

These are `string` subtypes tagged with a unique symbol brand. The TypeScript compiler rejects a call like `getDomain(someUserId)` at the type level.

Construction goes through a validator (Zod at the boundary, per CONVENTIONS §2.1) — you do not cast. When reading from Drizzle the column is typed `string`; narrow to the brand at the repo/DAO layer (PR 13 onward).

## Insert helpers

`exactOptionalPropertyTypes` + Drizzle's inferred `InsertModel` disagree on the shape of optional columns: Drizzle wants the key *absent*, the strict mode rejects `undefined`-valued keys. The `stripUndefined()` helper in `src/db/inserts.ts` is a thin filter you pass through at the insert call site:

```ts
import { stripUndefined } from "@opencoo/shared/db";
await db.insert(domains).values(stripUndefined({ slug, name, retentionDays }));
```

## `$onUpdate` is app-side only

`updated_at` is wired with `.$onUpdate(() => new Date())`. This is a **Drizzle-side hook** — a raw `UPDATE domains SET …` via `sql\`\`` or psql does **not** trigger it. v0.1 relies on the invariant that every write goes through the typed Drizzle query builder. If a future feature needs DB-side enforcement, add a trigger in a new migration — don't expect the `$onUpdate` hook to fire for SQL that bypasses the builder.

## Append-only invariant (THREAT-MODEL §2 invariant 8)

Certain tables must never grow an `updated_at` column because their *purpose* is the permanent audit trail — rewriting a past row would falsify the record. The current set:

- `page_citations` — per-page provenance ledger (which source compiled which page, when).
- `redaction_events` — one row per guard-triggered redaction, metadata only (§3.3).
- `erasure_log` — one row per admin-triggered erasure verb (§15).
- `miner_suppressions` — operator "don't propose this again" decisions.
- `agent_runs` — one row per agent harness invocation (architecture §7.1); `started_at`/`ended_at` are the run's open/close markers, not mutation history.

These tables have no `updated_at`, no `$onUpdate`, and no mutation-path writes from engine code. The only DELETE source is retention pruning in the Cleanup pipeline.

### Two lines of enforcement

1. **Schema-level** — `packages/shared/tests/append-only-invariant.test.ts` introspects each table via `getTableConfig()` and fails CI if any sneaks in an `updated_at`, `modified_at`, `edited_at`, or other `*_at` column that isn't in the allow-list (`created_at`, plus `started_at`/`ended_at` on `agent_runs`).
2. **Query-level** — `opencoo/no-update-append-only` (ESLint) rejects `db.update(tbl)` and `db.delete(tbl)` calls where `tbl` is in the hard-coded set of append-only table symbols. Handles chain forms like `db.with(cte).update(pageCitations)`. See the rule file's top-of-file comment for the "how to add a table" pointer — append the Drizzle symbol name to `TABLES` there AND to `APPEND_ONLY_TABLES` in the test AND to the §2 invariant-8 list in `THREAT-MODEL.md`.

## Mutation-adjacent tables

Some tables carry a state machine we *do* update in place — notably `catalog_candidate`, whose `status` transitions `detected` → `drafted` → `reviewing` → `approved`/`rejected` → `promoted` as reviewers move it through the Review Dashboard. `reviewed_by` + `reviewed_at` populate alongside. This is a sanctioned UPDATE path and is explicitly carved out of §2 invariant 8 in THREAT-MODEL.md.

Mutation-adjacent tables keep `updated_at` (via the shared `updatedAt()` helper) and behave like normal CRUD rows. They do NOT appear in the append-only invariant test.

## Logger

`@opencoo/shared/logger` exposes a `ConsoleLogger` + `Logger` interface + `loggerFromEnv()` factory. One JSON object per call, terminated by `\n` — downstream collectors split on newline. Four levels (`debug` | `info` | `warn` | `error`) with threshold filtering, and `child(ctx)` for layering request-scoped context without mutating the parent. `loggerFromEnv` reads `LOG_LEVEL` and falls back to `info` on unknown/empty values.

```ts
import { loggerFromEnv } from "@opencoo/shared/logger";

const log = loggerFromEnv();
log.info("pipeline started", { pipeline: "ingestion-scanner" });
const run = log.child({ runId: "r-abc" });
run.warn("upstream slow", { latencyMs: 4500 });
```

Stream and clock are test seams — `new ConsoleLogger({ stream, now })` captures output into an array and pins `ts`. Use these in tests, never `console.log`.

### Invariant 11 callout

The logger does **not** filter raw prompts/responses at runtime. THREAT-MODEL §2 invariant 11 ("never log raw prompts at `info`") is a code-review gate, not a firewall. Prompts + responses go through the `llm_usage_debug` table (see §LLM router below), gated on `LLM_DEBUG_LOG=1` and TTL-pruned by Cleanup. If a reviewer sees prompt bytes reaching `logger.info`/`warn`/`error`, that's a ship-blocker.

## Errors

`@opencoo/shared/errors` defines the three-class taxonomy from CONVENTIONS §2.4: `ValidationError` (→ immediate DLQ), `TransientError` (→ linear backoff), `UpstreamQuotaError` (→ exponential backoff). All three extend `OpencooError`, which stores a `readonly errorClass: ErrorClass` discriminant and chains `Error.cause` through an options object.

```ts
import { ValidationError, isOpencooError } from "@opencoo/shared/errors";

try {
  schema.parse(input);
} catch (zodError) {
  throw new ValidationError("field missing", { cause: zodError });
}

// downstream retry:
if (isOpencooError(err)) {
  switch (err.errorClass) {
    case "validation":     /* no retry */ break;
    case "transient":      /* linear backoff */ break;
    case "upstream-quota": /* exponential backoff */ break;
  }
}
```

The `cause` argument is routed through a ternary internally so `super(msg, { cause: undefined })` — a type error under `exactOptionalPropertyTypes` — never fires.

## Text normalization

`@opencoo/shared/text-normalize` exposes a single `normalize(input: string): string` applied ONCE at the router edge before a document's bytes reach the Classifier (architecture §6.3). Pipeline order: BOM strip → line-ending normalize (CRLF/CR → LF) → NFC → control-strip (C0/C1 except `\t`/`\n`) → fence-aware whitespace collapse → blank-line cap (3+ LFs → 2). Idempotent by construction — a second pass is a no-op.

```ts
import { normalize } from "@opencoo/shared/text-normalize";

const clean = normalize(rawDocumentBytes);
```

Fenced code blocks (``` or ~~~, CommonMark rules) are preserved verbatim — their interior is not touched, and an unclosed fence at EOF keeps its remainder verbatim too. Outside fences, leading whitespace on each line is preserved (nested Markdown lists survive), interior runs of `[ \t]+` collapse to one space, trailing whitespace trims.

**IMPORTANT: 4-space indented code blocks are NOT preserved** — converters must emit fenced blocks per architecture §6.3. A line with 4+ leading spaces is collapsed like any other prose line; only `` ``` `` or `~~~` with 0-3 leading spaces opens a fence.

## Credential store

`@opencoo/shared/credential-store` is the single sanctioned path for persisting integration secrets (Drive OAuth refresh tokens, Asana tokens, webhook HMAC keys, etc). AES-256-GCM with a 12-byte random IV per write, AAD bound to `(credential_id, schemaRef)` so a cross-row substitution can't decrypt, stamped with `encryption_version` for forward migration. THREAT-MODEL §3.6 governs every detail.

```ts
import {
  DrizzleCredentialStore,
  loadEncryptionKey,
} from "@opencoo/shared/credential-store";

const store = new DrizzleCredentialStore({
  db,
  key: loadEncryptionKey(process.env),
  logger,
});

const id = await store.write({
  name: "drive-primary",
  schemaRef: "source-drive/v1",
  plaintext: Buffer.from(refreshToken),
});
// ...
const record = await store.read(id);
// record.plaintext is a Buffer; never logged, never serialised.
```

Key source of truth: `ENCRYPTION_KEY_FILE` (Docker secrets) > `ENCRYPTION_KEY` (inline base64). Both are validated at boot to decode to exactly 32 bytes; a misconfigured env fails `loadEncryptionKey` with a `ConfigError` before any write runs.

**Invariants enforced (code + tests):**
- Unique IV per write — 100-encrypt property test against identical plaintext.
- AAD binding — a cross-row ciphertext+iv+aad substitution throws `IntegrityError` before decryption is attempted.
- Version dispatch — `decryptVersion(1, …)` handles `encryption_version = 1`; anything else throws `UnsupportedEncryptionVersionError`. Writes always stamp `CURRENT_VERSION`.
- **Never log plaintext.** Every `credential.{write,read,rotate,delete,read_failed}` event carries only `credential_id` and `schema_ref` (public metadata). `credential-store-never-logs-plaintext.test.ts` runs a byte-scan of the captured log stream against sentinel plaintexts on every CI run — a regression anywhere in the pipeline flips it Red.

**KMS-swappable by design.** The `CredentialStore` interface is four methods (`write/read/rotate/delete`). A future KMS-backed implementation drops in by constructor substitution; no call-site changes.

**Fixture.** `InMemoryCredentialStore` satisfies the same interface with a `Map<id, row>`, for use-case tests that don't need to spin up Postgres. Row shape mirrors the `credentials` pgTable byte-for-byte.

**Testing with pglite.** `DrizzleCredentialStore` unit tests use `@electric-sql/pglite` (real Postgres, WASM, in-process) rather than pg-mem — the latter's bytea adapter re-encodes through UTF-8 text and destroys binary fidelity. pglite gives us true round-trip integrity at test time.

## LLM router

`@opencoo/shared/llm-router` is the single sanctioned path every LLM call in opencoo takes — no agent, pipeline, or adapter imports `ai` / `@ai-sdk/*` directly (enforced by the `opencoo/no-direct-llm-sdk` lint rule, which allowlists only `packages/shared/src/llm-router/providers/**`). THREAT-MODEL §2 invariant 5 is enforced by construction here.

```ts
import {
  LlmRouter,
  InMemoryQueuePauser,
  MockLlmClient,
} from "@opencoo/shared/llm-router";
import { createProvider } from "@opencoo/shared/llm-router/providers";

const provider = await createProvider("openai");
const router = new LlmRouter({
  db, env: process.env, logger,
  pauser: new InMemoryQueuePauser(),
  provider,
});

const result = await router.generateText({
  domainId, tier: "worker",
  pipelineOrAgent: "ingest.classifier",
  prompt: "classify this document",
});
```

**Enforcement order per call:**
1. Load the domain, parse `llm_policy` (Zod). Empty `{}` → `FALLBACK_POLICY`; malformed → `LlmPolicyViolationError`.
2. `local_only: true` + non-ollama provider → `LlmPolicyViolationError`.
3. Budget pre-check: `computeMonthToDateCost + estimateCost` vs `domains.llm_budget_monthly_cap_usd`. Breach → pause queues, insert `budget-cap-breach` marker row, throw `LlmBudgetExceededError` (errorClass `upstream-quota`). Fail-closed — provider is never called.
4. Provider call, wrapped in try/finally.
5. `llm_usage` row always written in `finally` — cost accounting stays honest even on provider failure.
6. If `LLM_DEBUG_LOG=1`: matching `llm_usage_debug` row written, FK-paired to the usage row (Cleanup cascades both together when pruning).

**Providers.** Four lazy-import modules under `providers/`: `openai`, `anthropic`, `google`, `ollama` (wrapped via `@ai-sdk/openai-compatible`). Each fails with a targeted `LlmProviderError` ("Install `@ai-sdk/openai` to use the OpenAI provider") if the SDK isn't installed, so ops gets an actionable message instead of a `Cannot find module` stack trace.

**Testing.** `@opencoo/shared/llm-router/testing` exports `MockLlmClient` — a table-driven provider that returns registered `{text, tokensIn, tokensOut}` for matching `(model, promptIncludes)` pairs and throws `LlmProviderError` on any unmatched call (no silent fallbacks). Use this instead of mocking provider SDKs directly.

**Never-log-plaintext regression lock.** The router emits `llm.policy.fallback`, `llm.budget.breached` metadata via the injected Logger — no prompt text, no response text. `llm_usage_debug` carries the content; that table is append-only (§2 invariant 8) and gated on the env flag.

## Cost tracker

`@opencoo/shared/cost-tracker` holds the pricing table and the month-to-date aggregation SQL.

```ts
import { costFor, computeMonthToDateCost } from "@opencoo/shared/cost-tracker";

const dollars = costFor("gpt-4o-mini", 1000, 500);
const mtd = await computeMonthToDateCost(db, domainId);
```

`PRICING` is keyed per-model with USD-per-token (NOT per-thousand). `FALLBACK_PRICING` is deliberately slightly more expensive than the cheapest known model so unknown-model calls over-reserve rather than under-count — budget-cap prefers false-positive breaches to leaking spend. Update `PRICING` when vendor price sheets change; the `cost-tracker.unknown_model` warn event logs the model name on the fallback path so stale pricing shows up in ops.

`computeMonthToDateCost(db, domainId)` runs a single `SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage WHERE domain_id = ? AND timestamp >= date_trunc('month', now())`. NULL `domain_id` rows are never counted — they exist for bootstrap-time pings that don't belong to any cap.

## Wiki write

`@opencoo/shared/wiki-write` is the sole sanctioned path for writing to a Karpathy-wiki Gitea repo. Everything else is forbidden by the `opencoo/no-direct-gitea-write` ESLint rule — compilers, lints, review-apply, builder-deploy all route through this function. THREAT-MODEL §2 invariant 2 + §3.5 govern every detail.

```ts
import {
  wikiWrite,
  InMemoryWikiWriteQueue,
  InMemoryDeleteCap,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";

const adapter = new InMemoryWikiAdapter(); // real impl (PR 11) swaps in
const deps = {
  adapter,
  queue: new InMemoryWikiWriteQueue(),
  deleteCap: new InMemoryDeleteCap(),
  logger, clock: () => new Date(), instanceId: "prod-a",
};

const { sha } = await wikiWrite(deps, {
  domainSlug: "wiki-executive",
  tag: "[compiler]",
  description: "compile strategy.md",
  author: { name: "opencoo-engine", email: "engine@opencoo.local" },
  caller: { kind: "engine" },
  operations: [
    { mode: "replace", path: "strategy.md", content: "# Strategy\n..." },
  ],
});
```

**Enforcement order per call (fail-fast):**
1. Zod-parse the input — bad shape → `WikiWriteInputError` (preserves ZodError via `cause`).
2. `validatePath` each op.path — belt-and-suspenders regex + `wiki-` prefix + `..` component + control-char check. Bad path → `WikiPathError`.
3. Delete-cap `reserve` for engine callers (admin bypasses) — breach → `WikiWriteCapExceededError`.
4. Only then `queue.enqueue(domainSlug, …)` — per-domain promise-chain means two calls on the same domain serialise; different domains run concurrently.
5. Up to 3 adapter retries on `status: "stale"` — past that → `WikiWriteStaleError`.

**Commit message shape** (CONVENTIONS §4.2 + §3.5):
```
${tag} ${description}

${body?}

${Co-authored-by?*}
Opencoo-Instance: ${instanceId}
```

First line is always `${tag} ${description}` — downstream audit tooling keys on the literal tag prefixes from the 8-entry Zod enum. `Opencoo-Instance` trailer is always last; `Co-authored-by` trailers (one per entry) sit before it when provided.

**Delete cap.** In-memory per-(domain, YYYY-MM-DD) counter; default 10 deletes/day per domain for engine callers. Admin callers bypass with explicit `{ kind: "admin", userId }` — the `userId` provides audit alongside the git commit author. Reserve-at-entry semantics: retries don't refund budget. Counter resets on date change via injected `clock`; v0.1 state does NOT survive process restart (PR 17 may promote to Postgres).

**Queue memory behaviour (v0.1 caveat).** `InMemoryWikiWriteQueue` keeps a `Map<DomainSlug, Promise>` and never clears entries after a task resolves. Memory grows proportional to distinct domains touched (not call count) — acceptable for single-process deployments that restart daily. PR 13 replaces with BullMQ for horizontal scale.

**InMemoryWikiAdapter fixture.** Use-case tests under `@opencoo/shared/wiki-write/testing` pass this in place of the real Gitea adapter. `writeAtomic` derives `sha256(prevHead || serialisedOps)` so SHA chaining is deterministic and testable. The `@internal inject(domainSlug, path, content)` method is the backdoor that tests use to simulate external writes for stale-retry scenarios — production code must never touch it.

## Adapter contract suites

`@opencoo/shared/adapter-contract-tests/*` exports reusable vitest suites for every adapter boundary in the architecture. Every concrete adapter package (`converter-docling`, a future `converter-pandoc`, the output/source/automation families in later PRs) consumes the same generator and passes the same assertion matrix — one source of truth for the contract, so two adapters cannot silently drift from each other.

```ts
import { documentConverterContract } from "@opencoo/shared/adapter-contract-tests/document-converter";
import { converterDocling } from "@opencoo/converter-docling";
import { MockDoclingClient } from "@opencoo/converter-docling/testing";

documentConverterContract(
  (canned) => converterDocling({ client: new MockDoclingClient(canned) }),
  fixtures,
);
```

Currently shipped boundaries:

- `./adapter-contract-tests/document-converter` — `DocumentConverterAdapter`, `ConversionError`, `ConversionResult`, `StructureSignals`, `DocumentConverterFixtures`, and the 11-assertion `documentConverterContract(makeAdapter, fixtures, options?)` generator. Covers: stable slug, declared `mimeTypes`, Markdown happy-path, xlsx-no-pipes degradation, pptx-no-headings degradation, six stripped tag families (`script|style|iframe|object|embed|form`), neutralised `javascript:` URIs, stripped `on*=` handlers, `ConversionError` on malformed bytes, idempotent `text-normalize`. Governed by THREAT-MODEL §3.2.

### Adding a new boundary

1. Define the interface + `*Error` class + `*Fixtures` shape in `src/adapter-contract-tests/<boundary>.ts`.
2. Export the generator: `export function <boundary>Contract(makeAdapter, fixtures, options?)`.
3. Add the submodule to the `exports` map in `package.json` at `./adapter-contract-tests/<boundary>`.
4. Re-export from `src/adapter-contract-tests/index.ts` (barrel).
5. Document the invariants the generator asserts in this README section.

Adapters import the suite as a library (`import { … } from "@opencoo/shared/adapter-contract-tests/<boundary>"`). The suite imports `vitest` at the top level — adapter test files get their vitest globals from the usual spot, so this works without any peer-dep dance.

## Migrations

`drizzle-kit generate` is idempotent — `tests/generate-idempotent.test.ts` asserts this by running it twice into temp dirs and byte-diffing the outputs (with volatile `when`/`id` fields normalized). A regression means the schema code has picked up nondeterminism — investigate and fix, do not delete the test.

Scripts:

- `pnpm --filter @opencoo/shared db:generate [--name <label>]` — emit a new migration.
- `pnpm --filter @opencoo/shared db:check` — drift-check the generated SQL against the schema snapshot.

Runtime migration (`drizzle-kit migrate` / a `migrator` script) lands with engine boot in PR 06.
