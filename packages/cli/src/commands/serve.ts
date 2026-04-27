/**
 * `opencoo` (bare, no subcommand) — long-running boot verb
 * (phase-a appendix / plan radiant-diffie). architecture.md
 * §14.5 specifies the bare verb as the unified boot path; today
 * it boots only `engine-self-operating` (no ingestion BullMQ
 * workers wired in v0.1), but the verb stays stable when phase-b
 * adds workers.
 *
 * `runServe` is pure orchestration around `start({env})` from
 * `@opencoo/engine-self-operating`. The engine module is
 * dynamic-imported so the CLI cold-start stays fast for the
 * other (already-wired) verbs that don't need it. `start()`
 * already opens its own pg.Pool, ioredis client, builds the
 * GiteaClient, registers admin-API + static-UI in the correct
 * order, and binds `app.listen({host:"0.0.0.0", port})`. We do
 * NOT open a second pool here — that would double connection
 * counts and run a parallel auth handshake.
 *
 * No `process.env.*` reads here: the env object threads through
 * to `start()`, which uses `requireWithFile` / `readWithFile`
 * (engine-scaffold) for every var. The `no-feature-env-vars`
 * ESLint rule (THREAT-MODEL §2 invariant 9) is non-negotiable.
 */
import type { EventEmitter } from "node:events";

import pc from "picocolors";

import { exitOk, exitRuntimeError, isExitSentinel } from "../lib/exit.js";

/** The minimal shape of a started engine that `runServe`
 *  consumes. `@opencoo/engine-self-operating`'s `StartedEngine`
 *  satisfies this structurally (see start.ts:69-83 in shared/
 *  engine-scaffold) — we depend only on `close()` here. */
export interface ServeStartedEngine {
  close(): Promise<void>;
}

/** Production `startFactory` shape — matches `start({env})` from
 *  `@opencoo/engine-self-operating`. Tests substitute via the
 *  `startFactory` test seam. */
export type ServeStartFactory = (opts: {
  readonly env: Record<string, string | undefined>;
}) => Promise<ServeStartedEngine>;

/** Subset of `EventEmitter` `runServe` consumes. `process`
 *  satisfies it; tests pass an `EventEmitter` instance to
 *  control signal emission. */
export interface ServeSignalSource {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export interface ServeArgs {
  readonly env: Record<string, string | undefined>;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  /** @internal Test seam — defaults to `start` from
   *  `@opencoo/engine-self-operating` (dynamic-imported). */
  readonly startFactory?: ServeStartFactory;
  /** @internal Test seam — defaults to the Node `process`
   *  emitter. */
  readonly signalSource?: ServeSignalSource | EventEmitter;
  /** @internal Test seam — defaults to `exitOk` from
   *  `lib/exit.js`. Tests pass a vi.fn() to capture the code
   *  without halting the runner. */
  readonly exit?: (code: number) => void;
}

/** Default `startFactory` — dynamic-imports
 *  `@opencoo/engine-self-operating` so the verb's cold-start
 *  cost is paid only by callers who actually boot. */
async function defaultStartFactory(opts: {
  readonly env: Record<string, string | undefined>;
}): Promise<ServeStartedEngine> {
  const mod = await import("@opencoo/engine-self-operating");
  return mod.start({ env: opts.env });
}

/** Boot the engine and block until SIGTERM/SIGINT.
 *
 * Wiring contract:
 *   1. Construct the engine via `startFactory({env})`. The
 *      engine's own `start.ts` opens the pg.Pool + ioredis +
 *      Fastify listener. Failures bubble out of `runServe` so
 *      the bin.ts catch / commander error path renders them.
 *   2. Register SIGTERM + SIGINT listeners on `signalSource`
 *      (defaults to `process`). Either signal triggers a
 *      graceful shutdown: await `engine.close()` then call
 *      `exit(0)`. Listeners are symmetrically removed in the
 *      shutdown path so test runs don't leak handlers.
 *   3. Return a promise that resolves AFTER shutdown completes.
 *      Tests await this to synchronise with the close path.
 */
export async function runServe(args: ServeArgs): Promise<void> {
  const startFactory = args.startFactory ?? defaultStartFactory;
  const signalSource = args.signalSource ?? process;
  // Default exit routes through `exitOk` from lib/exit.js so the
  // production exit-code convention (0 = success) stays
  // consistent with migrate / setup / doctor / etc. The SIGTERM/
  // SIGINT happy path is always a clean exit(0); other codes
  // flow through bin.ts's catch via thrown errors.
  const exit = args.exit ?? ((_code: number): void => {
    exitOk();
  });

  args.stdout.write(pc.dim("opencoo: starting...\n"));
  let engine: ServeStartedEngine;
  try {
    engine = await startFactory({ env: args.env });
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.red(
        `opencoo: failed to start (${err instanceof Error ? err.message : String(err)})\n`,
      ),
    );
    return exitRuntimeError();
  }
  args.stdout.write(pc.green("opencoo: started\n"));

  return new Promise<void>((resolve) => {
    // Memoise close-path dispatch. Two SIGTERMs in <1ms (e.g. an
    // orchestrator escalating from SIGTERM → SIGINT, or a script
    // double-firing) must not call engine.close() twice or
    // exit(0) twice. Synchronous removeListener after the FIRST
    // signal would also work — but memoising belt-and-braces
    // protects against signal sources that don't honor listener
    // removal (some test doubles, future re-wiring). Mirrors the
    // engine-scaffold close memoisation (start.ts:186-199).
    let closing: Promise<void> | undefined;
    const shutdown = (signal: "SIGTERM" | "SIGINT"): void => {
      if (closing !== undefined) return;
      args.stdout.write(pc.dim(`opencoo: ${signal} received, shutting down\n`));
      // Symmetric listener cleanup — no leaks across test runs.
      signalSource.removeListener("SIGTERM", onSigterm);
      signalSource.removeListener("SIGINT", onSigint);
      closing = engine
        .close()
        .catch((err: unknown) => {
          args.stderr.write(
            pc.red(
              `opencoo: shutdown error (${err instanceof Error ? err.message : String(err)})\n`,
            ),
          );
        })
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
