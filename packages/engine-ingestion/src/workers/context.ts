/**
 * `WorkerContext` — runtime dependencies every ingestion worker
 * callback resolves before invoking its pipeline (PR-M1, phase-a
 * appendix #5).
 *
 * The context is constructed ONCE at engine boot (in `start.ts`
 * when `mode: 'workers'`) and threaded into every per-pipeline
 * worker handler. This mirrors the `RunXxxArgs` shape each
 * pipeline already accepts — the wrapper layer is a thin glue.
 *
 * `IngestionRunEventEmitter` is a deliberately narrow subset of
 * the engine-self-operating SseBus's `emitRunEvent` method. The
 * `no-cross-engine-import` ESLint rule (THREAT-MODEL §2 invariant
 * 10) forbids engine-ingestion from importing the SseBus type
 * directly; the orchestrator (`packages/cli/src/commands/serve.ts`)
 * is the ONLY place where both engines meet, and at that seam the
 * SseBus structurally satisfies this interface.
 */
import type { Pool } from "pg";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { Logger } from "@opencoo/shared/logger";
import type { GuardAdapter } from "@opencoo/shared/adapter-contract-tests/guard";
import type { WebhookVerifier } from "@opencoo/shared/webhook-verifier";
import type {
  WikiAdapter,
  WikiAuthor,
  WikiWriteDeps,
} from "@opencoo/shared/wiki-write";

import type { WebhookQueueLike } from "../intake/webhook-receiver.js";
import type { SourceAdapterRegistry } from "../pipelines/scanner.js";

/**
 * Run-lifecycle event emitted by the worker on `completed` /
 * `failed` BullMQ events. Mirrors the SseBus `RunEvent` shape so
 * the cross-engine seam in `serve.ts` is a literal pass-through.
 *
 * `errorMessage` (NOT `errorClass`) — Copilot finding: the typed
 * retry taxonomy `OpencooError.errorClass: 'transient' |
 * 'upstream-quota' | 'validation'` is a load-bearing name across
 * the codebase. The SSE bridge writes a SCRUBBED FREE-TEXT message
 * (BullMQ `failed` event's `Error.message`), which is a different
 * concept and deserves a different field name. The peer
 * `RunEvent.errorMessage?: string` field on the SseBus side carries
 * the same shape so the structural-typing seam at the orchestrator
 * still holds.
 */
export interface IngestionRunEvent {
  readonly runId: string;
  readonly definitionSlug: string;
  readonly status: "running" | "success" | "failed" | "timeout";
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Scrubbed (`scrubPat`) + capped-at-200-chars `Error.message`
   *  from a BullMQ `failed` event. Free text, NOT the retry-class
   *  taxonomy. Only set when `status === 'failed'`. */
  readonly errorMessage?: string;
}

/**
 * Per-failure pipeline event emitted by the Compilation Worker when
 * it catches an error and writes `status='failed'` to the intake row
 * (PR-W4, phase-a appendix #14). Distinct from `IngestionRunEvent`
 * because:
 *   - it is per-INTAKE-ROW (not per-job) — one event = one operator-
 *     facing failure on the Activity feed;
 *   - it carries the typed `errorClass` (`OpencooError.errorClass`
 *     literal — `'transient' | 'upstream-quota' | 'validation'`)
 *     plus a scrubbed + truncated `errorTextSnippet` so the SSE
 *     subscriber can render both the chip and the human-readable
 *     reason without an extra round-trip;
 *   - the `bindingId` lets the Activity feed render the binding
 *     label resolved via the source-binding cache.
 *
 * THREAT-MODEL §3.6 invariant 11: `errorTextSnippet` is scrubbed via
 * `safeErrorMessage` and capped at 200 chars BEFORE it reaches the
 * bus. Subscribers can render it directly as React text (no HTML
 * escape needed; React text rendering is implicit escape).
 */
export interface IntakeFailedEvent {
  readonly bindingId: string;
  readonly intakeId: string;
  /** `OpencooError.errorClass` literal when the caught error was an
   *  `OpencooError`; otherwise `'transient'` (the safe default since
   *  unknown causes get a cheap one-shot retry). */
  readonly errorClass: string;
  /** Scrubbed + 200-char-capped `Error.message`. THREAT-MODEL §3.6
   *  invariant 11: no credential bytes. */
  readonly errorTextSnippet: string;
  /** ISO timestamp when the event was emitted. Lets the Activity
   *  feed group "similar failures in the last hour" without
   *  introducing a clock skew between the worker and the browser. */
  readonly occurredAt: string;
}

/** Narrow subset of the SseBus the workers need. The cross-engine
 *  seam in `cli/serve.ts` casts the SseBus to this shape — both
 *  satisfy it structurally because `RunEvent` is a superset of
 *  `IngestionRunEvent`.
 *
 *  PR-W4 widens the contract with `emitIntakeFailed` — the
 *  cross-engine seam declares the same method on `ServeSseBus`. */
export interface IngestionRunEventEmitter {
  emitRunEvent(event: IngestionRunEvent): void;
  /** Optional in the contract so tests + composition-incomplete
   *  shapes can satisfy the type without the W4 wiring. Production
   *  builds (engine-self-operating's SseBus) always provide it; the
   *  Compilation Worker null-guards before calling. */
  emitIntakeFailed?(event: IntakeFailedEvent): void;
}

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Runtime dependencies threaded into every worker. Constructed
 * ONCE at engine boot.
 */
export interface WorkerContext {
  /** pg.Pool the engine opened. Workers wrap it in a Drizzle
   *  handle on demand for the pipelines that need one. */
  readonly db: DrizzleDb;
  /** Logger — every worker logs lifecycle + errors here. The
   *  `scrubPat` helper is applied to error message strings before
   *  they reach the SSE bus to honour THREAT-MODEL §3.6 invariant
   *  11 (no credential bytes in logs). */
  readonly logger: Logger;
  /** Per-domain LLM router; the Compilation Worker invokes it. */
  readonly router: LlmRouter;
  /** WikiWriteDeps wired with the production `WikiAdapter`,
   *  per-domain BullMQ queue, and delete-cap. Compilation +
   *  Index-rebuild use it. */
  readonly wikiDeps: WikiWriteDeps;
  /** WikiAdapter for read-only paths (Index Rebuilder lists
   *  `*.md` via this). */
  readonly wikiAdapter: WikiAdapter;
  /** Service-account author stamped on machine commits. */
  readonly author: WikiAuthor;
  /** Guard adapter the Compilation Worker invokes on every job. */
  readonly guardAdapter: GuardAdapter;
  /** Source-adapter registry the Scanner uses to dispatch by
   *  binding adapter slug. */
  readonly adapterRegistry: SourceAdapterRegistry;
  /** Optional run-event emitter — when provided, BullMQ
   *  `completed` / `failed` events flow through here so the
   *  Activity feed shows worker runs. */
  readonly sseBus?: IngestionRunEventEmitter;
  /** Scanner-side `add` handle for the `ingestion.scanner.classify`
   *  queue. The orchestrator constructs the producer-side `Queue`
   *  ONCE at boot and shares the handle here so the Scanner
   *  enqueues into the same queue the Compile worker dequeues
   *  from. Optional in test contexts where the Scanner's adapter
   *  registry is empty (so `enqueue.add` is never called). */
  readonly enqueue?: import("../pipelines/scanner.js").ScannerEnqueue;
  /** Round-2 fix (Copilot #56) — webhook receiver dependencies the
   *  orchestrator threads through `start({ mode: 'workers' })` so
   *  the receiver mounts on the engine's primary Fastify app and
   *  starts accepting deliveries automatically. All four are
   *  required for production webhook ingest; optional in tests
   *  that only exercise worker behavior. */
  readonly credentialStore?: CredentialStore;
  readonly webhookVerifier?: WebhookVerifier;
  /** BullMQ Queue handle for the scanner queue (`ingestion.scanner`)
   *  the webhook receiver enqueues onto when a delivery is
   *  accepted. Distinct from `enqueue` (which targets
   *  `ingestion.scanner.classify` and is consumed by the Compile
   *  worker). The Scanner worker dequeues from `ingestion.scanner`
   *  and ignores the job payload — the receiver only needs to
   *  trigger a scan. */
  readonly webhookScannerQueue?: WebhookQueueLike;
  /** BullMQ Queue handle for the intake DLQ (`ingestion.intake.dlq`)
   *  the webhook receiver enqueues onto when a delivery is
   *  rejected (signature mismatch, missing adapter, missing
   *  credentials). */
  readonly webhookDlqQueue?: WebhookQueueLike;
}

/** Production-shape — narrow type for the raw `pg.Pool` so the
 *  composition root can pass it directly without a Drizzle wrap.
 *  The orchestrator wraps the pool once and stores the Drizzle
 *  handle on the WorkerContext. */
export type ProductionPool = Pool;
