/**
 * TTY detection (PR 30 / plan #135).
 *
 * `source forget` requires interactive confirmation when run
 * without `--dry-run`. The interactive prompt is impossible
 * over a pipe, so non-TTY invocations without `--dry-run` exit
 * 1 with a clear "either --dry-run or run interactively"
 * message — preventing the destructive `forget` from running
 * unattended in a script.
 */
export interface TtyDetector {
  /** True when the process has an interactive stdin
   *  (`process.stdin.isTTY`). False on pipes / cron / CI.
   *  Test seams override this. */
  readonly isInteractive: boolean;
}

export function detectTty(): TtyDetector {
  return { isInteractive: Boolean(process.stdin.isTTY) };
}
