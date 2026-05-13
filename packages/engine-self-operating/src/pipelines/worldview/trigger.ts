/**
 * Worldview-recompile trigger pipeline — PR-W1 (phase-a appendix #13).
 *
 * Per architecture.md §9.4, worldview recompiles are event-driven:
 *
 *   - `Worldview-Impact: high`     → recompile after a 15-minute
 *                                    debounce window (multiple highs
 *                                    in the window collapse to one
 *                                    recompile).
 *   - `Worldview-Impact: medium`   → recompile when ≥3 mediums have
 *                                    accumulated since the last
 *                                    recompile, OR when the oldest
 *                                    pending medium is ≥24h old.
 *   - `Worldview-Impact: low`      → never trigger alone.
 *   - 24h safety-net               → registered as a BullMQ repeat
 *                                    job by the composition root;
 *                                    that path enqueues directly
 *                                    onto the worldview-compile
 *                                    queue with `triggerType:
 *                                    'safety-net'` and does NOT
 *                                    go through this pipeline.
 *
 * This pipeline is invoked by the composition root (CLI serve.ts)
 * on a short BullMQ repeat job (every 5 min by default). On each
 * tick:
 *
 *   1. Read the per-domain commits since the last recompile (we
 *      track the last seen sha + the per-domain trigger state in
 *      memory — single-process v0.1 shape; the safety-net cron is
 *      the resilience floor when the process restarts).
 *   2. Parse `Worldview-Impact:` trailers from each commit message.
 *      Ignore the worker's OWN `Worldview-Recompile:` trailers
 *      (those are recompile commits, not ingest commits).
 *   3. Apply the per-domain debounce rules above.
 *   4. Enqueue a `worldview.compile` job on the worldview queue
 *      with `triggerType` set + a stable-shape jobId for dedupe.
 *
 * In-memory state is the right shape for v0.1: a partial-recovery
 * after restart at worst means the safety-net cron picks up the
 * domain at its next quiet-hour run. The trigger state does NOT
 * need to survive engine restarts.
 */
import type { Queue } from "bullmq";

import type { Logger } from "@opencoo/shared/logger";
import { safeErrorMessage } from "@opencoo/shared/scrub";

import type {
  WorldviewCompileJob,
  WorldviewCompileTriggerType,
} from "../../workers/worldview-compiler-worker.js";

/** Debounce window for `high`-impact commits — multiple highs that
 *  land inside this window collapse to a single recompile. The
 *  WINDOW STARTS at the first high since the last recompile, NOT
 *  at the most recent high (a stream of highs at <15-min intervals
 *  would otherwise indefinitely defer the recompile). */
export const TRIGGER_HIGH_DEBOUNCE_MS = 15 * 60 * 1000;
/** Threshold of accumulated mediums that triggers a recompile
 *  regardless of age. */
export const TRIGGER_MEDIUM_COUNT_THRESHOLD = 3;
/** Maximum age of the oldest pending medium before we force a
 *  recompile even if the count threshold hasn't been hit. */
export const TRIGGER_MEDIUM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Per-domain commit-log window the trigger inspects per tick. The
 *  pipeline runs every few minutes; even a busy domain emits at
 *  most a handful of commits per tick. 30 is generous + safely
 *  under the 50-commit cap on `listRecentCommits`. */
export const TRIGGER_LOG_WINDOW = 30;

export type WorldviewImpactLevel = "high" | "medium" | "low";

/** Per-domain accounting carried between trigger ticks. Single-
 *  process v0.1 shape — kept in memory by the orchestrator. */
export interface DomainTriggerState {
  /** SHA of the last commit the trigger has classified. Commits
   *  newer than this SHA on the next tick are the unprocessed
   *  delta. `null` means "no commits seen yet" — the first tick
   *  classifies every commit in the log window. */
  lastSeenSha: string | null;
  /** Timestamp of the most recent recompile this pipeline enqueued
   *  for the domain. Used to ignore the worldview-compiler-worker's
   *  own commits — we don't want a recompile of a recompile. */
  lastRecompileAt: Date | null;
  /** Timestamp of the FIRST high commit since the last recompile.
   *  `null` if no highs are pending. */
  pendingHighWindowStartedAt: Date | null;
  /** Timestamp of the FIRST medium commit since the last
   *  recompile + the running count. The pipeline checks both
   *  thresholds (count + age) on every tick. */
  pendingMediumFirstAt: Date | null;
  pendingMediumCount: number;
}

/** Construct an empty state row for a domain on first encounter. */
export function freshDomainTriggerState(): DomainTriggerState {
  return {
    lastSeenSha: null,
    lastRecompileAt: null,
    pendingHighWindowStartedAt: null,
    pendingMediumFirstAt: null,
    pendingMediumCount: 0,
  };
}

/** Recent-commit row the pipeline consumes. Matches the shape
 *  `wiki-gitea` exposes via `listRecentCommits`, narrowed to the
 *  fields the trigger needs. */
export interface TriggerCommit {
  readonly sha: string;
  readonly message: string;
  /** ISO-8601 string from Gitea. The pipeline parses it once via
   *  `new Date()`; invalid strings are dropped silently (a future
   *  Gitea version that emits a different shape degrades to
   *  "skip this commit" rather than crashing the tick). */
  readonly authoredAt: string;
}

/** Per-domain accessor the pipeline calls. The orchestrator wires
 *  this around the wikiAdapter's `listRecentCommits`; tests inject
 *  a stub. */
export interface DomainCommitsReader {
  (args: {
    readonly domainSlug: string;
    readonly limit: number;
  }): Promise<readonly TriggerCommit[]>;
}

/** Per-domain row the orchestrator passes in. The pipeline keeps
 *  per-domain state in `stateByDomain` keyed by `domainId` — the
 *  `domainSlug` is used to scope the commit-log read. */
export interface TriggerDomain {
  readonly domainId: string;
  readonly domainSlug: string;
}

/** Narrow shape of the worldview-compile queue the trigger enqueues
 *  onto. Matches BullMQ `Queue.add`. The orchestrator passes the
 *  real Queue instance — the type bound here keeps the pipeline
 *  decoupled from bullmq imports. */
export interface WorldviewCompileQueue {
  add(
    name: string,
    data: WorldviewCompileJob,
    opts?: unknown,
  ): Promise<unknown>;
}

export interface RunWorldviewTriggerArgs {
  readonly domains: ReadonlyArray<TriggerDomain>;
  readonly readCommits: DomainCommitsReader;
  readonly queue: WorldviewCompileQueue | undefined;
  /** Per-domain state map, keyed by `domainId`. Mutated in place;
   *  the orchestrator persists this between ticks by passing the
   *  same Map. */
  readonly stateByDomain: Map<string, DomainTriggerState>;
  readonly logger: Logger;
  readonly now: () => Date;
}

export interface TriggerEnqueueRecord {
  readonly domainId: string;
  readonly domainSlug: string;
  readonly triggerType: WorldviewCompileTriggerType;
  readonly jobId: string;
}

export interface RunWorldviewTriggerResult {
  /** Every recompile enqueued during this tick. Tests assert on
   *  this; production logs the count. */
  readonly enqueued: ReadonlyArray<TriggerEnqueueRecord>;
}

/** Parse every `Worldview-Impact: <level>` trailer line in a commit
 *  message, returning the level enum values. Unknown levels are
 *  silently skipped — a future model release that emits a new
 *  level shouldn't crash the trigger; the safety-net cron is the
 *  fallback. */
export function parseWorldviewImpactLines(
  message: string,
): ReadonlyArray<WorldviewImpactLevel> {
  const out: WorldviewImpactLevel[] = [];
  for (const line of message.split(/\r?\n/)) {
    const match = /^Worldview-Impact:\s*(\S+)/i.exec(line.trim());
    if (match === null) continue;
    const level = match[1]?.toLowerCase();
    if (level === "high" || level === "medium" || level === "low") {
      out.push(level);
    }
  }
  return out;
}

/** Pick the strongest impact level out of a list. Used to collapse
 *  multiple bullets on the same commit to a single classification —
 *  one `high` overrides any number of mediums or lows. */
function strongestLevel(
  levels: ReadonlyArray<WorldviewImpactLevel>,
): WorldviewImpactLevel | null {
  if (levels.length === 0) return null;
  if (levels.includes("high")) return "high";
  if (levels.includes("medium")) return "medium";
  return "low";
}

/** True iff the commit message bears a `Worldview-Recompile:` trailer
 *  (i.e. it was emitted by this very pipeline / the safety-net cron).
 *  Recompile commits MUST NOT re-trigger themselves. */
function isWorldviewRecompileCommit(message: string): boolean {
  for (const line of message.split(/\r?\n/)) {
    if (/^Worldview-Recompile:/i.test(line.trim())) return true;
  }
  return false;
}

/** Run one trigger tick: per domain, read recent commits, classify
 *  by impact, update per-domain state, enqueue recompiles per the
 *  §9.4 debounce rules. Returns the list of enqueued records (for
 *  tests + log emission).
 *
 *  Caller (orchestrator) wraps this in a BullMQ repeat job; this
 *  function is pure-ish (mutates the supplied state map, calls the
 *  injected `readCommits` + `queue.add`). */
export async function runWorldviewTrigger(
  args: RunWorldviewTriggerArgs,
): Promise<RunWorldviewTriggerResult> {
  const enqueued: TriggerEnqueueRecord[] = [];
  const now = args.now();

  for (const domain of args.domains) {
    let state = args.stateByDomain.get(domain.domainId);
    if (state === undefined) {
      state = freshDomainTriggerState();
      args.stateByDomain.set(domain.domainId, state);
    }

    let commits: readonly TriggerCommit[];
    try {
      commits = await args.readCommits({
        domainSlug: domain.domainSlug,
        limit: TRIGGER_LOG_WINDOW,
      });
    } catch (err) {
      // Best-effort: a transient Gitea outage on ONE domain must
      // not block trigger evaluation for the others. The safety-net
      // cron is the resilience floor when a domain's listRecentCommits
      // keeps failing — operators see this in the log.
      args.logger.warn("worldview.trigger.read_failed", {
        domain_id: domain.domainId,
        domain_slug: domain.domainSlug,
        error: safeErrorMessage(err),
      });
      continue;
    }

    // The commit log is newest-first per `listRecentCommits`. We
    // want to process commits in CHRONOLOGICAL order so the trigger
    // sees the timeline as it happened (a high that arrived BEFORE
    // a medium opens the high-debounce window, not the medium count).
    // Reverse a copy + then filter to commits newer than `lastSeenSha`.
    const ordered = [...commits].reverse();
    let newCommitsStartIdx = 0;
    if (state.lastSeenSha !== null) {
      const seenIdx = ordered.findIndex(
        (c) => c.sha === (state as DomainTriggerState).lastSeenSha,
      );
      // If we DID find the seen sha, start AFTER it. If we didn't,
      // the log has rolled past our window — assume we missed
      // nothing material (safety-net cron is the floor) and start
      // from the oldest entry returned.
      newCommitsStartIdx = seenIdx >= 0 ? seenIdx + 1 : 0;
    }
    const newCommits = ordered.slice(newCommitsStartIdx);
    if (newCommits.length === 0) {
      // No new commits — but we still evaluate the medium-age
      // gate below (a pending medium can age over 24h between ticks
      // even when no new commits arrive).
    }

    // Classify every new commit + update pending counters.
    for (const commit of newCommits) {
      // Always advance lastSeenSha so a recompile-tick following a
      // no-trigger commit still moves the cursor forward.
      state.lastSeenSha = commit.sha;
      if (isWorldviewRecompileCommit(commit.message)) continue;
      const level = strongestLevel(
        parseWorldviewImpactLines(commit.message),
      );
      if (level === null) continue;
      const authoredAt = parseAuthoredAt(commit.authoredAt) ?? now;
      if (level === "high") {
        if (state.pendingHighWindowStartedAt === null) {
          state.pendingHighWindowStartedAt = authoredAt;
        }
      } else if (level === "medium") {
        if (state.pendingMediumFirstAt === null) {
          state.pendingMediumFirstAt = authoredAt;
        }
        state.pendingMediumCount += 1;
      }
      // "low": never triggers alone — no state mutation.
    }

    // Decision: does this domain need a recompile?
    //
    // `high` debounce: the recompile fires when (now - first-high)
    // >= 15 min. Multiple highs collapse to one recompile.
    if (
      state.pendingHighWindowStartedAt !== null &&
      now.getTime() - state.pendingHighWindowStartedAt.getTime() >=
        TRIGGER_HIGH_DEBOUNCE_MS
    ) {
      const record = await enqueueRecompile({
        args,
        domain,
        triggerType: "trailer-high",
        now,
      });
      if (record !== null) {
        enqueued.push(record);
        resetPendingAfterRecompile(state, now);
        // After a recompile we skip the medium-threshold check —
        // the recompile sweeps every pending impact, so the medium
        // counters reset too.
        continue;
      }
    }

    // `medium` thresholds: count >= 3 OR oldest >= 24h.
    const mediumOldEnough =
      state.pendingMediumFirstAt !== null &&
      now.getTime() - state.pendingMediumFirstAt.getTime() >=
        TRIGGER_MEDIUM_MAX_AGE_MS;
    const mediumThreshold =
      state.pendingMediumCount >= TRIGGER_MEDIUM_COUNT_THRESHOLD;
    if (mediumOldEnough || mediumThreshold) {
      const record = await enqueueRecompile({
        args,
        domain,
        triggerType: "trailer-medium",
        now,
      });
      if (record !== null) {
        enqueued.push(record);
        resetPendingAfterRecompile(state, now);
      }
    }
  }

  if (enqueued.length > 0) {
    args.logger.info("worldview.trigger.tick", {
      enqueued_count: enqueued.length,
      enqueued: enqueued.map((e) => ({
        domain_slug: e.domainSlug,
        trigger_type: e.triggerType,
      })),
    });
  }

  return { enqueued };
}

interface EnqueueArgs {
  readonly args: RunWorldviewTriggerArgs;
  readonly domain: TriggerDomain;
  readonly triggerType: WorldviewCompileTriggerType;
  readonly now: Date;
}

async function enqueueRecompile(
  ctx: EnqueueArgs,
): Promise<TriggerEnqueueRecord | null> {
  const { args, domain, triggerType, now } = ctx;
  const queue = args.queue;
  if (queue === undefined) {
    // Composition didn't wire the queue (engine boot tolerance).
    // The safety-net cron is the fallback; log + continue.
    args.logger.warn("worldview.trigger.queue_missing", {
      domain_id: domain.domainId,
      trigger_type: triggerType,
    });
    return null;
  }
  const jobId = mintTriggerJobId({
    domainId: domain.domainId,
    triggerType,
    now,
  });
  try {
    await queue.add(
      WORLDVIEW_COMPILE_JOB_NAME,
      {
        domainId: domain.domainId,
        domainSlug: domain.domainSlug,
        triggerType,
      },
      {
        jobId,
        removeOnComplete: 100,
        removeOnFail: 1000,
      },
    );
  } catch (err) {
    args.logger.warn("worldview.trigger.enqueue_failed", {
      domain_id: domain.domainId,
      trigger_type: triggerType,
      error: safeErrorMessage(err),
    });
    return null;
  }
  return {
    domainId: domain.domainId,
    domainSlug: domain.domainSlug,
    triggerType,
    jobId,
  };
}

/** Reset per-domain pending counters after a recompile lands. */
function resetPendingAfterRecompile(
  state: DomainTriggerState,
  now: Date,
): void {
  state.lastRecompileAt = now;
  state.pendingHighWindowStartedAt = null;
  state.pendingMediumFirstAt = null;
  state.pendingMediumCount = 0;
}

function parseAuthoredAt(raw: string): Date | null {
  if (raw.length === 0) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Stable jobId shape: `worldview-<triggerType>-<domainId>-<ts>`.
 *  The wallclock suffix prevents two back-to-back triggers from
 *  the same domain from colliding on BullMQ's id-dedupe; in
 *  practice the per-domain debounce + reset paths above already
 *  prevent this, but a stable + collision-free shape simplifies
 *  log greps. PR-W1 (phase-a appendix #13). */
export function mintTriggerJobId(args: {
  readonly domainId: string;
  readonly triggerType: WorldviewCompileTriggerType;
  readonly now: Date;
}): string {
  return `worldview-${args.triggerType}-${args.domainId}-${args.now.getTime()}`;
}

/** Queue name + job-name constants. Pinned for cross-package
 *  agreement: the worker dequeues from `WORLDVIEW_COMPILE_QUEUE_SLUG`
 *  with job-name `WORLDVIEW_COMPILE_JOB_NAME`. */
export const WORLDVIEW_COMPILE_QUEUE_SLUG =
  "selfop.worldview.compile" as const;
export const WORLDVIEW_COMPILE_JOB_NAME = "worldview.compile" as const;

// Re-export the BullMQ Queue shape narrowed for orchestrator
// composition. Production wires `new Queue(WORLDVIEW_COMPILE_QUEUE_SLUG)`;
// tests inject a stub matching `WorldviewCompileQueue`.
export type { Queue as BullMQQueue };
