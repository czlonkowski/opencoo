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

import { exitOk } from "../lib/exit.js";

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

/** Boot the engine and block until SIGTERM/SIGINT. */
export async function runServe(args: ServeArgs): Promise<void> {
  const startFactory = args.startFactory ?? defaultStartFactory;
  args.stdout.write(pc.dim("opencoo: starting...\n"));
  await startFactory({ env: args.env });
  args.stdout.write(pc.green("opencoo: started\n"));
}
