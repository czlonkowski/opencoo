/**
 * `opencoo` (bare, no subcommand) — long-running boot verb
 * (architecture.md §14.5, plan radiant-diffie). Pure orchestration
 * around `start({env})` from BOTH engines:
 *
 *   1. `@opencoo/engine-self-operating` — Fastify admin API + UI
 *      hosting + agent harness.
 *   2. `@opencoo/engine-ingestion` — webhook receiver + BullMQ
 *      Workers (PR-M1, phase-a appendix #5).
 *
 * The two engines run in the SAME Node process and share their
 * pg.Pool / ioredis connection / SseBus / read-only ingestion
 * Queue handle through the orchestrator. The engine modules are
 * dynamic-imported so other CLI verbs that don't need either
 * engine pay zero cold-start cost.
 *
 * No `process.env.*` reads here: the env object threads through
 * to `start()`, which uses `requireWithFile` / `readWithFile` for
 * every var. The `no-feature-env-vars` ESLint rule (THREAT-MODEL
 * §2 invariant 9) is non-negotiable.
 *
 * # What this verb actually wires (PR-M1)
 *
 * Today, `runServe` boots BOTH engines in sequence:
 *
 *   1. `engine-self-operating.start({env})` — the management
 *      server. Failure exits the process with code 2.
 *   2. `engine-ingestion.start({env})` in `'probes-only'` mode
 *      (the engine-side default). This brings up the Fastify
 *      health/ready probes and the webhook receiver, but does
 *      NOT construct the BullMQ Workers — `mode: 'workers'`
 *      requires a fully composed `WorkerContext` (production
 *      WikiAdapter / LlmRouter / GuardAdapter /
 *      SourceAdapterRegistry / live wiki + credential wiring),
 *      and that composition root is owned by **PR-M2**, not
 *      this PR. Failure of the ingestion boot is logged to
 *      stderr and SWALLOWED — the management UI stays up and
 *      the operator can triage; we do not exit.
 *
 * Net effect after PR-M1: the operator can `pnpm opencoo` and
 * land on the management UI, the webhook receiver accepts
 * deliveries and writes them to `webhook_events`, and jobs
 * queue into Redis. Nothing dequeues them yet — workers ship
 * their boot path here but the engine boots in `'probes-only'`
 * by default. **PR-M2 flips the default ingestion factory to
 * `mode: 'workers'`** with a real WorkerContext built from the
 * shared pg.Pool / Redis / SseBus, at which point queued jobs
 * start getting drained and persisted to Gitea automatically.
 *
 * The boot-tolerance for the ingestion side mirrors
 * engine-self-operating's admin-API gating pattern (env
 * incomplete → log + skip, don't crash the process).
 */
import type { EventEmitter } from "node:events";

import pc from "picocolors";

import { exitOk, exitRuntimeError, isExitSentinel } from "../lib/exit.js";

/** Minimal `StartedEngine` shape consumed by `runServe`.
 *  Both engines satisfy it structurally. */
export interface ServeStartedEngine {
  close(): Promise<void>;
}

/** Matches `start({env})` from `@opencoo/engine-self-operating`. */
export type ServeStartFactory = (opts: {
  readonly env: Record<string, string | undefined>;
}) => Promise<ServeStartedEngine>;

/** Matches `start({env})` from `@opencoo/engine-ingestion`. The
 *  shape is the same as the self-op factory — the orchestrator
 *  just chains both. */
export type ServeIngestionStartFactory = (opts: {
  readonly env: Record<string, string | undefined>;
}) => Promise<ServeStartedEngine>;

/** Subset of `EventEmitter` `runServe` consumes — `process`
 *  satisfies it; tests pass an `EventEmitter` to drive signals. */
export interface ServeSignalSource {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export interface ServeArgs {
  readonly env: Record<string, string | undefined>;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  /** @internal Test seam — defaults to dynamic-import of `start`
   *  from `@opencoo/engine-self-operating`. */
  readonly startFactory?: ServeStartFactory;
  /** @internal Test seam — defaults to dynamic-import of `start`
   *  from `@opencoo/engine-ingestion`. PR-M1, phase-a appendix
   *  #5 — co-boot of the ingestion engine in the same process so
   *  webhook events actually get dequeued, classified, compiled,
   *  and persisted to Gitea automatically. */
  readonly startIngestionFactory?: ServeIngestionStartFactory;
  /** @internal Test seam — defaults to the Node `process` emitter. */
  readonly signalSource?: ServeSignalSource | EventEmitter;
  /** @internal Test seam — defaults to `exitOk`. Tests pass a
   *  `vi.fn()` to capture the code without halting the runner. */
  readonly exit?: (code: number) => void;
}

/** @internal Default `startFactory` — dynamic-imports the engine
 *  so the verb's cold-start cost is paid only on boot. */
async function defaultStartFactory(opts: {
  readonly env: Record<string, string | undefined>;
}): Promise<ServeStartedEngine> {
  const mod = await import("@opencoo/engine-self-operating");
  return mod.start({ env: opts.env });
}

/** @internal Default ingestion `startFactory`. Boots
 *  engine-ingestion in `'probes-only'` mode by default — the
 *  production WorkerContext composition root that wires
 *  WikiAdapter + GuardAdapter + LlmRouter + SourceAdapterRegistry
 *  lands in PR-M2. The fallback still gives the operator a
 *  webhook receiver + DB-backed intake table; jobs queue up in
 *  Redis and are dequeued once PR-M2 ships the production
 *  WorkerContext. */
async function defaultIngestionStartFactory(opts: {
  readonly env: Record<string, string | undefined>;
}): Promise<ServeStartedEngine> {
  const mod = await import("@opencoo/engine-ingestion");
  // `mode` defaults to 'probes-only' inside the engine itself —
  // boots without WorkerContext. PR-M2 swaps this to 'workers'
  // once the production composition root lands.
  return mod.start({ env: opts.env });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Boot the engines and block until SIGTERM/SIGINT.
 *
 *  1. `startFactory({env})` opens engine-self-operating (Fastify
 *     listener + admin API + agent harness). Failures route
 *     through `exit(2)` with the upstream error to stderr.
 *  2. `startIngestionFactory({env})` opens engine-ingestion
 *     alongside. Failures here are LOGGED but don't abort — the
 *     operator still gets the management UI; the ingestion side
 *     re-attempts on next boot. (PR-M1 boot-tolerance: PR-M2
 *     adds production composition that completes the loop.)
 *  3. SIGTERM + SIGINT trigger graceful shutdown of BOTH engines
 *     in parallel: await `engine.close()` on each (ingestion
 *     drains BullMQ workers within the engine's 30s window),
 *     then `exit(0)`. Listeners are symmetrically removed in
 *     the shutdown path so test runs don't leak handlers.
 *  4. The returned promise resolves AFTER shutdown completes;
 *     tests await it to synchronise with the close path.
 */
export async function runServe(args: ServeArgs): Promise<void> {
  const startFactory = args.startFactory ?? defaultStartFactory;
  const startIngestionFactory =
    args.startIngestionFactory ?? defaultIngestionStartFactory;
  const signalSource = args.signalSource ?? process;
  // Default exit routes 0 through `exitOk` and non-zero through
  // `exitRuntimeError`, matching the bin.ts catch behaviour.
  const exit =
    args.exit ??
    ((code: number): void => {
      if (code === 0) exitOk();
      else exitRuntimeError();
    });

  args.stdout.write(pc.dim("opencoo: starting...\n"));
  let selfOpEngine: ServeStartedEngine;
  try {
    selfOpEngine = await startFactory({ env: args.env });
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.red(`opencoo: failed to start (${describeError(err)})\n`),
    );
    return exit(2);
  }

  // Co-boot engine-ingestion. Boot-tolerant — a missing
  // production composition root in PR-M1 logs to stderr but
  // doesn't abort the management UI. PR-M2 wires the production
  // WorkerContext that closes the loop.
  let ingestionEngine: ServeStartedEngine | undefined;
  try {
    ingestionEngine = await startIngestionFactory({ env: args.env });
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.yellow(
        `opencoo: ingestion engine did not boot (${describeError(err)}) — management UI is still up; webhook receiver is unavailable until next restart\n`,
      ),
    );
    ingestionEngine = undefined;
  }

  args.stdout.write(pc.green("opencoo: started\n"));

  /** Close one engine, logging (but swallowing) any close error so
   *  the sibling engine still gets to drain. */
  const closeWithLog = (
    label: string,
    engine: ServeStartedEngine,
  ): Promise<void> =>
    engine.close().catch((err: unknown) => {
      args.stderr.write(
        pc.red(`opencoo: ${label} shutdown error (${describeError(err)})\n`),
      );
    });

  return new Promise<void>((resolve) => {
    // Memoise the OUTER dispatch — engine.close() is itself
    // idempotent (engine-scaffold start.ts:186-199), but two
    // SIGTERMs in <1ms must not write the "shutting down" line,
    // call exit(0), or resolve() twice.
    let closing: Promise<void> | undefined;
    const shutdown = (signal: "SIGTERM" | "SIGINT"): void => {
      if (closing !== undefined) return;
      args.stdout.write(
        pc.dim(`opencoo: ${signal} received, shutting down\n`),
      );
      signalSource.removeListener("SIGTERM", onSigterm);
      signalSource.removeListener("SIGINT", onSigint);
      // Close both engines in parallel — each engine's close()
      // is internally idempotent; closeAll on the workers handle
      // (when present) drains BullMQ within a 30s window.
      const closes: Promise<void>[] = [closeWithLog("self-op", selfOpEngine)];
      if (ingestionEngine !== undefined) {
        closes.push(closeWithLog("ingestion", ingestionEngine));
      }
      closing = Promise.all(closes)
        .then(() => undefined)
        .finally(() => {
          exit(0);
          resolve();
        });
    };
    const onSigterm = (): void => shutdown("SIGTERM");
    const onSigint = (): void => shutdown("SIGINT");
    signalSource.on("SIGTERM", onSigterm);
    signalSource.on("SIGINT", onSigint);
  });
}
