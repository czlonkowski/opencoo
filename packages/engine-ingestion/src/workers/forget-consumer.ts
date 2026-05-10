/**
 * Forget consumer worker (PR-W6, phase-a appendix #11 follow-up
 * task #65).
 *
 * Drains the two queues PR-W1's `createForgetJobEnqueuer` produces:
 *
 *   - `wiki.recompile` (job name `recompile_page`) — the page
 *     survives the forget but its body must drop the forgotten
 *     binding's contributions. Worker semantics:
 *       1. Read existing `page_citations` for `(domainSlug, pagePath)`.
 *       2. Partition: forgotten (`source_binding_id === bindingId`) vs
 *          remaining.
 *       3. If no remaining citations → no-op + warn. The companion
 *          `delete_page` job (the route enqueues both classes
 *          separately when the planner partitions correctly) handles
 *          the page removal. This branch only fires defensively when
 *          the route's planner and the worker disagree (race between
 *          plan + consume), which the brief's edge case calls out.
 *       4. Otherwise: DELETE the forgotten citations (cascade
 *          hygiene — the page_citations table allows DELETE for the
 *          erasure path per the schema's APPEND-ONLY-modulo-DELETE
 *          comment) and invoke the injected `recompilePage` hook
 *          with the remaining citations.
 *
 *     The actual recompile body (the LLM call that re-derives the
 *     page from the remaining citations) is owned by `recompilePage`
 *     — production wires a v0.1 stub that logs intent only,
 *     mirroring the CLI `recompile.ts` audit-only shape (the engine
 *     re-compiles on its next cron tick / next ingestion event from
 *     a remaining binding). v0.2 will replace the stub with a real
 *     Thinker recompile.
 *
 *   - `wiki.delete` (job name `delete_page`) — the page has no
 *     remaining attribution and must be removed entirely. Worker
 *     semantics:
 *       1. Delete the `page_citations` rows for `(domainSlug, pagePath)`
 *          BEFORE the wiki delete (cascade hygiene; the planner
 *          itself doesn't prune these — the route's audit row
 *          carried the COUNTS, the rows themselves outlive the
 *          enqueue and need to be cleared by us).
 *       2. Issue a `wikiWrite` with `mode: 'delete'` op. Caller is
 *          `{ kind: 'admin', userId: callerUsername }` — the route
 *          ALREADY reserved against the shared DeleteCap before
 *          enqueueing (source-bindings.ts:933), so `engine` caller
 *          would double-reserve. The W1 enqueue.ts comment block
 *          documents this contract:
 *            "the route already reserved against the cap via
 *             deleteCap.reserve(...) BEFORE enqueuing, so the worker
 *             should mark its calls as admin-caller to avoid
 *             double-reserving".
 *       3. Defensive: if the wiki adapter reports the page is
 *          already gone (readPage returns null), no-op + warn —
 *          another forget could have raced ahead.
 *
 * # Audit
 *
 * The route already wrote `source_binding.forget` with COUNTS at
 * enqueue time. The worker emits a per-job logger entry with
 * `(binding_id, domain_slug, page_path)` and exits — NO additional
 * `admin_audit_log` insert (that would double-count the same
 * operation). Per-job log lines flow into the standard execution log
 * via the SSE bridge.
 *
 * # Failure semantics
 *
 * Throwing from the handler is the BullMQ-canonical way to signal a
 * retryable failure. The producer-side queue defaults govern attempts
 * + backoff; a transport blip retries; a permanent failure (binding
 * row missing entirely) DLQs after the attempts cap. We throw bare
 * Error here — the route's audit row is the operator-facing record;
 * BullMQ's job log + the per-job logger entry are the engine-facing
 * record.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  Worker,
  type ConnectionOptions,
  type Job,
  type WorkerOptions,
} from "bullmq";

import {
  WIKI_DELETE_JOB_NAME,
  WIKI_DELETE_QUEUE_SLUG,
  WIKI_RECOMPILE_JOB_NAME,
  WIKI_RECOMPILE_QUEUE_SLUG,
  type ForgetJobPayload,
} from "@opencoo/shared/forget";
import type { Logger } from "@opencoo/shared/logger";
import { safeErrorMessage } from "@opencoo/shared/scrub";
import {
  wikiWrite,
  type WikiAuthor,
  type WikiWriteDeps,
  type WikiWriteInput,
} from "@opencoo/shared/wiki-write";
import type { DomainSlug } from "@opencoo/shared/db";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** A surviving citation row the recompile hook receives. Carries
 *  enough to identify the source without leaking the underlying
 *  document content (which the worker doesn't have anyway — refetch
 *  is the recompile hook's responsibility when v0.2 wires real
 *  Thinker recompile). */
export interface RemainingCitation {
  readonly sourceBindingId: string;
  readonly sourceRef: string;
  readonly promptVersion: string | null;
}

/** Hook the recompile worker invokes with the post-drop citations.
 *  v0.1 production wires a stub that logs intent only; v0.2 wires a
 *  real Thinker recompile path that re-derives the page body from
 *  the remaining citations (refetch the source content for each
 *  remaining citation, run mergePage, write atomically).
 *
 *  The hook returning normally signals success. Throwing rolls the
 *  job into BullMQ's retry path. */
export type RecompilePageHook = (args: {
  readonly bindingId: string;
  readonly domainSlug: string;
  readonly pagePath: string;
  readonly callerUsername: string;
  readonly remainingCitations: readonly RemainingCitation[];
}) => Promise<void>;

interface CitationRow {
  readonly source_binding_id: string;
  readonly source_ref: string;
  readonly prompt_version: string | null;
}

export interface ForgetRecompileDeps {
  readonly db: Db;
  readonly logger: Logger;
  /** v0.1 production wires a stub that logs intent + returns; v0.2
   *  swaps in a real Thinker recompile. Tests inject a spy. */
  readonly recompilePage: RecompilePageHook;
}

export interface ForgetDeleteDeps {
  readonly db: Db;
  readonly logger: Logger;
  /** Production wikiDeps from the WorkerContext. Carries the SHARED
   *  DeleteCap instance the route reserves against — passing this
   *  through ensures any cap-budget reads in the future see the
   *  same source-of-truth. */
  readonly wikiDeps: WikiWriteDeps;
  /** Service-account author stamped on the `[review-applied]`-style
   *  delete commit. Same `WikiAuthor` the orchestrator already wires
   *  for compile / index-rebuild commits — not a separate identity. */
  readonly author: WikiAuthor;
}

/** Build the recompile-job handler. Pure — for unit testing inject
 *  a spy `recompilePage` and exercise the partition + db-delete
 *  branches without standing up BullMQ.
 *
 *  v0.1 contract:
 *    - `domainSlug`, `pagePath`, `bindingId`, `callerUsername` are
 *      forwarded from the producer payload; the worker does not
 *      re-derive them.
 *    - The page-existence check is the citations lookup. A page with
 *      zero recorded citations means the route's planner over-
 *      reported (race or operator concurrency); we warn + no-op,
 *      we do NOT throw (no point retrying — the page truly has no
 *      citations and never will via this binding). */
export function buildForgetRecompileHandler(
  deps: ForgetRecompileDeps,
): (job: Job<ForgetJobPayload>) => Promise<void> {
  return async (job) => {
    const payload = job.data;
    const citations = await readCitations(
      deps.db,
      payload.domainSlug,
      payload.pagePath,
    );

    if (citations.length === 0) {
      // Race: the route's planner saw citations but they're gone now
      // (operator concurrency, prior forget, or a manual db prune).
      // No-op + warn — retrying won't bring them back.
      deps.logger.warn("forget_consumer.recompile.page_missing", {
        binding_id: payload.bindingId,
        domain_slug: payload.domainSlug,
        page_path: payload.pagePath,
      });
      return;
    }

    const remaining = citations.filter(
      (c) => c.source_binding_id !== payload.bindingId,
    );
    if (remaining.length === 0) {
      // Every citation on this page is from the forgotten binding.
      // The companion `delete_page` job already handles the page;
      // this recompile is redundant. Log + no-op (do NOT recompile,
      // do NOT delete — the delete worker owns the page-removal
      // commit AND the cascade citation prune).
      deps.logger.info("forget_consumer.recompile.no_remaining_citations", {
        binding_id: payload.bindingId,
        domain_slug: payload.domainSlug,
        page_path: payload.pagePath,
        forgotten_count: citations.length,
      });
      return;
    }

    // Drop the forgotten binding's citation rows for THIS page so the
    // post-recompile state matches reality (the page no longer cites
    // this binding's source). DELETE is permitted on `page_citations`
    // for the erasure path per the schema's "APPEND-ONLY ... Source
    // forgetting happens via DELETE" comment.
    await deps.db.execute(sql`
      DELETE FROM page_citations
      WHERE domain_slug = ${payload.domainSlug}
        AND page_path = ${payload.pagePath}
        AND source_binding_id = ${payload.bindingId}::uuid
    `);

    // Invoke the recompile hook. v0.1 wires a stub that logs only;
    // v0.2 will replace it with a real Thinker recompile.
    await deps.recompilePage({
      bindingId: payload.bindingId,
      domainSlug: payload.domainSlug,
      pagePath: payload.pagePath,
      callerUsername: payload.callerUsername,
      remainingCitations: remaining.map((r) => ({
        sourceBindingId: r.source_binding_id,
        sourceRef: r.source_ref,
        promptVersion: r.prompt_version,
      })),
    });

    deps.logger.info("forget_consumer.recompile.completed", {
      binding_id: payload.bindingId,
      domain_slug: payload.domainSlug,
      page_path: payload.pagePath,
      remaining_count: remaining.length,
    });
  };
}

/** Build the delete-job handler. Pure — for unit testing inject
 *  a stub `wikiDeps` (with the in-memory adapter + cap fixture) and
 *  exercise the cascade-prune + delete branches without standing up
 *  BullMQ. */
export function buildForgetDeleteHandler(
  deps: ForgetDeleteDeps,
): (job: Job<ForgetJobPayload>) => Promise<void> {
  return async (job) => {
    const payload = job.data;

    // Defensive existence probe — if the page is already gone (a
    // concurrent forget, a manual delete, a prior retry of THIS
    // job that landed the wiki commit then crashed before the db
    // prune), we still want to clear any orphaned citation rows
    // and exit cleanly. Retrying a delete against a missing page
    // would surface as a confusing wiki transport error.
    const existing = await deps.wikiDeps.adapter.readPage(
      payload.domainSlug as DomainSlug,
      payload.pagePath,
    );

    // Always prune citation rows first — they're the cascade record
    // for this page regardless of whether the wiki page itself
    // already vanished.
    await deps.db.execute(sql`
      DELETE FROM page_citations
      WHERE domain_slug = ${payload.domainSlug}
        AND page_path = ${payload.pagePath}
    `);

    if (existing === null) {
      deps.logger.warn("forget_consumer.delete.page_already_gone", {
        binding_id: payload.bindingId,
        domain_slug: payload.domainSlug,
        page_path: payload.pagePath,
      });
      return;
    }

    // Issue the wiki delete via the standard wikiWrite path.
    //
    // Caller is `{ kind: 'admin', userId: callerUsername }` per the
    // W1 enqueue.ts contract: the admin-API route already reserved
    // the cap budget BEFORE enqueueing this job; an `engine` caller
    // would double-reserve. wikiWrite's per-domain queue still
    // serialises this delete against any concurrent engine writes,
    // and the `[review-applied]` tag matches what the management UI
    // surfaces for operator-triggered actions.
    const writeInput: WikiWriteInput = {
      domainSlug: payload.domainSlug,
      tag: "[review-applied]",
      description: `forget: delete ${payload.pagePath}`,
      author: deps.author,
      caller: { kind: "admin", userId: payload.callerUsername },
      operations: [{ mode: "delete", path: payload.pagePath }],
    };
    try {
      await wikiWrite(deps.wikiDeps, writeInput);
    } catch (err) {
      deps.logger.error("forget_consumer.delete.wiki_write_failed", {
        binding_id: payload.bindingId,
        domain_slug: payload.domainSlug,
        page_path: payload.pagePath,
        // Round-2 fix #2 style — scrub + cap. THREAT-MODEL §3.6.
        error: safeErrorMessage(err),
      });
      // Re-throw so BullMQ retries (cap-exceeded would surface as a
      // typed WikiWriteCapExceededError; the retry will succeed once
      // the daily window resets).
      throw err;
    }

    deps.logger.info("forget_consumer.delete.completed", {
      binding_id: payload.bindingId,
      domain_slug: payload.domainSlug,
      page_path: payload.pagePath,
    });
  };
}

async function readCitations(
  db: Db,
  domainSlug: string,
  pagePath: string,
): Promise<readonly CitationRow[]> {
  const result = (await db.execute(sql`
    SELECT source_binding_id::text AS source_binding_id,
           source_ref               AS source_ref,
           prompt_version           AS prompt_version
    FROM page_citations
    WHERE domain_slug = ${domainSlug}
      AND page_path = ${pagePath}
  `)) as unknown as { rows: CitationRow[] };
  return result.rows;
}

/** Default v0.1 production stub for the recompile hook.
 *
 *  v0.1 ships the FORGET-side cascade (drop forgotten citations) but
 *  DOES NOT yet ship the page-body recompile (re-derive the wiki
 *  page from the remaining citations via a Thinker call). Mirrors
 *  the CLI `recompile.ts` audit-only shape: the operator's intent is
 *  recorded; the engine re-compiles on its next cron tick / next
 *  ingestion event from a remaining binding.
 *
 *  v0.2 will replace this with a real Thinker recompile that
 *  refetches the remaining sources and re-runs `mergePage`. */
export function defaultRecompilePageStub(logger: Logger): RecompilePageHook {
  return async (args) => {
    logger.info("forget_consumer.recompile.audit_only_stub", {
      binding_id: args.bindingId,
      domain_slug: args.domainSlug,
      page_path: args.pagePath,
      remaining_count: args.remainingCitations.length,
      note: "v0.1 audit-only — page body recompile lands in v0.2 (Thinker recompile from remaining citations)",
    });
  };
}

const DEFAULT_FORGET_CONSUMER_CONCURRENCY = 1;

export interface StartForgetConsumerWorkersArgs {
  readonly recompileDeps: ForgetRecompileDeps;
  readonly deleteDeps: ForgetDeleteDeps;
  readonly connection: ConnectionOptions;
  readonly concurrency?: number;
  readonly autorun?: boolean;
}

export interface ForgetConsumerWorkers {
  readonly recompile: Worker<ForgetJobPayload, void>;
  readonly delete: Worker<ForgetJobPayload, void>;
}

/** Construct + return the two BullMQ Worker instances for the
 *  forget queues. The queue slugs (`wiki.recompile`, `wiki.delete`)
 *  are multi-dot so we bypass `buildEngineWorker` (which rejects
 *  dotted slugs) and use `new Worker(...)` directly — same pattern
 *  `compile-worker.ts` uses for `ingestion.scanner.classify`.
 *
 *  Concurrency defaults to 1: the recompile path issues a Thinker
 *  call (LLM-bound) and the delete path serialises through wikiWrite
 *  per-domain anyway. v0.2 may lift the cap if these become a
 *  bottleneck. */
export function startForgetConsumerWorkers(
  args: StartForgetConsumerWorkersArgs,
): ForgetConsumerWorkers {
  const recompileHandler = buildForgetRecompileHandler(args.recompileDeps);
  const deleteHandler = buildForgetDeleteHandler(args.deleteDeps);
  const concurrency = args.concurrency ?? DEFAULT_FORGET_CONSUMER_CONCURRENCY;
  const baseOpts: WorkerOptions = {
    connection: args.connection,
    concurrency,
    ...(args.autorun !== undefined ? { autorun: args.autorun } : {}),
  };
  const recompile = new Worker<ForgetJobPayload, void>(
    WIKI_RECOMPILE_QUEUE_SLUG,
    async (job) => {
      if (job.name !== WIKI_RECOMPILE_JOB_NAME) {
        // Defensive: the producer pins `recompile_page` per
        // enqueue.ts, but a malformed job (operator scripted an
        // off-spec add) should fail loud not silently no-op.
        throw new Error(
          `forget-consumer: ${WIKI_RECOMPILE_QUEUE_SLUG} expected job name ${WIKI_RECOMPILE_JOB_NAME}, got ${JSON.stringify(job.name)}`,
        );
      }
      return recompileHandler(job);
    },
    baseOpts,
  );
  const del = new Worker<ForgetJobPayload, void>(
    WIKI_DELETE_QUEUE_SLUG,
    async (job) => {
      if (job.name !== WIKI_DELETE_JOB_NAME) {
        throw new Error(
          `forget-consumer: ${WIKI_DELETE_QUEUE_SLUG} expected job name ${WIKI_DELETE_JOB_NAME}, got ${JSON.stringify(job.name)}`,
        );
      }
      return deleteHandler(job);
    },
    baseOpts,
  );
  return { recompile, delete: del };
}
