/**
 * CLI exit-code conventions (PR 30 / plan #135 decision Q6).
 *
 *   0 — success (or warning-only output to stderr)
 *   1 — operator error (bad flags, missing required env, etc.)
 *   2 — runtime/integration failure (DB unreachable, Gitea
 *       throwing, etc.)
 *
 * Commands call `exitOk` / `exitUserError` / `exitRuntimeError`
 * to terminate. In production they reach `process.exit(code)`,
 * which terminates without unwinding. Tests substitute a
 * `processExit` impl that throws an `ExitSentinel` so the
 * test runner can capture the code instead of dying — the
 * commands' try/catch must NOT swallow the sentinel (callers
 * use `isExitSentinel(err)` to re-throw).
 */
export type ProcessExit = (code: number) => never;

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 1;
export const EXIT_RUNTIME_ERROR = 2;

/** Sentinel thrown by the test substitute for `process.exit`.
 *  The runtime helpers re-throw it through; commands' try/catch
 *  blocks check `isExitSentinel(err)` to re-raise rather than
 *  treating it as a runtime error.
 *
 *  Production never sees this sentinel — `process.exit` doesn't
 *  throw, it terminates. */
export class ExitSentinel extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`__opencoo_exit:${code}`);
    this.name = "ExitSentinel";
    this.code = code;
  }
}

/** Discriminator for the catch blocks. */
export function isExitSentinel(err: unknown): err is ExitSentinel {
  return err instanceof ExitSentinel;
}

let processExit: ProcessExit = (code: number): never => {
  process.exit(code);
};

/** @internal Test seam — substitute the exit fn so assertions
 *  can capture the code without halting the test runner. The
 *  test fn typically throws `ExitSentinel` so the call stack
 *  unwinds back to the test body. */
export function __setProcessExit(fn: ProcessExit): void {
  processExit = fn;
}

/** @internal Test seam — restore the default `process.exit`. */
export function __resetProcessExit(): void {
  processExit = (code: number): never => {
    process.exit(code);
  };
}

export function exitOk(): never {
  return processExit(EXIT_OK);
}

export function exitUserError(): never {
  return processExit(EXIT_USER_ERROR);
}

export function exitRuntimeError(): never {
  return processExit(EXIT_RUNTIME_ERROR);
}
