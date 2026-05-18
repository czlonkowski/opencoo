/**
 * `useOptimisticPatch` — render-time client optimism for whitelisted
 * PATCH branches (PR-B5, wave-16, phase-a appendix #16).
 *
 * Contract:
 *   - `setValue(next)` flips local state IMMEDIATELY (optimistic),
 *     marks `saving=true`, and fires `applyFn(next)`.
 *   - On success: keep the new value, `saving=false`, `lastError`
 *     cleared.
 *   - On failure: roll back to the prior value (the value that was
 *     visible BEFORE this `setValue` call), `saving=false`,
 *     `lastError` set, and `opts.rollbackToast?.(err)` called so
 *     the caller can fire the B7 alert toast.
 *
 * Stale-rollback safety:
 *   When `setValue` is called more than once in quick succession,
 *   each in-flight commit owns its OWN rollback target. A late
 *   failure on commit #1 must NOT rollback to "initial" once
 *   commit #2 has already moved the visible value to "later" —
 *   the operator's latest intent wins, even if an earlier PATCH
 *   loses the race. We track this with a monotonic commit id so:
 *     - Only the MOST-RECENT commit's settle path touches state.
 *     - A successful #2 followed by a failed #1 surfaces neither
 *       a stale rollback nor a stale alert toast.
 *
 * Strict-mode safety:
 *   React 19 dev double-invokes initial renders + effects. The
 *   hook keeps no side-effecting `useEffect` that fires `applyFn`;
 *   `applyFn` is only triggered from inside `setValue`, which is a
 *   user-event handler (the strict-mode double-render does NOT
 *   re-run handler bodies). The internal refs are initialized
 *   exactly once via `useState` lazy initializers + `useRef`.
 *
 * Render-timing only:
 *   The hook does not change the server's audit-write-before-mutate
 *   invariant (THREAT-MODEL §3.13). It only shifts the moment the
 *   operator SEES the new value; the PATCH still round-trips and
 *   the audit row is still written before the row update. On
 *   rollback no audit row exists because the failed PATCH never
 *   reached the audit-commit step (or the audit-write-before-mutate
 *   sequence aborts as a unit). The server contract is unchanged.
 *
 * Parent-driven `currentValue`:
 *   The hook surfaces `currentValue` as `value` when no commit is
 *   in flight — so a parent re-fetch after PATCH-success that
 *   returns a NEW `currentValue` (e.g. the server canonicalized
 *   the operator's input) propagates cleanly. While a commit IS in
 *   flight, the optimistic value wins; on settle (success or
 *   rollback) the next render reads `currentValue` again.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseOptimisticPatchOptions {
  readonly rollbackToast?: (err: unknown) => void;
}

export interface UseOptimisticPatchResult<T> {
  readonly value: T;
  readonly setValue: (next: T) => void;
  readonly saving: boolean;
  readonly lastError: Error | null;
}

export function useOptimisticPatch<T>(
  currentValue: T,
  applyFn: (next: T) => Promise<T>,
  opts?: UseOptimisticPatchOptions,
): UseOptimisticPatchResult<T> {
  // The optimistically-applied value. The `set` flag distinguishes
  // "no pending optimism (mirror `currentValue`)" from "optimism
  // active". We can't use `undefined` as a sentinel because `T`
  // itself might be `undefined` for some callers.
  const [optimistic, setOptimistic] = useState<{
    readonly set: boolean;
    readonly value: T;
  }>({ set: false, value: currentValue });
  const [saving, setSaving] = useState(false);
  const [lastError, setLastError] = useState<Error | null>(null);

  // Monotonic commit id. The most-recent commit's id is the only
  // one whose settle path is honored; older settles are stale-
  // ignored to preserve "operator's latest intent wins" semantics.
  const lastCommitIdRef = useRef(0);
  // Tracks whether a commit is currently in flight so we know when
  // to re-mirror `currentValue` (post-settle).
  const inFlightCountRef = useRef(0);
  // Stable ref to the toast callback so `setValue` doesn't need to
  // be reconstructed on every render that changes the callback.
  const rollbackToastRef = useRef(opts?.rollbackToast);
  useEffect((): void => {
    rollbackToastRef.current = opts?.rollbackToast;
  }, [opts?.rollbackToast]);
  // Stable ref to `applyFn` so its identity changing across renders
  // doesn't perturb the `setValue` closure (callers commonly inline
  // the arrow function).
  const applyFnRef = useRef(applyFn);
  useEffect((): void => {
    applyFnRef.current = applyFn;
  }, [applyFn]);

  // Track the most-recent commit's PRIOR value so we know exactly
  // what to roll back to. This is the value the operator saw just
  // before they fired the current `setValue` — NOT the original
  // `currentValue`, which may have moved on already.
  const priorForLatestCommitRef = useRef<T>(currentValue);

  // When `currentValue` changes from the parent AND no commit is in
  // flight, drop the optimistic latch so the hook re-mirrors the
  // new prop value. (The stale-rollback path handles the "commit
  // in flight" case — see setValue below.)
  useEffect((): void => {
    if (inFlightCountRef.current === 0) {
      setOptimistic({ set: false, value: currentValue });
    }
    // We intentionally do NOT depend on `optimistic.value` here —
    // the goal is to react to PARENT-driven changes, not to chase
    // our own setState. (The alternative — a deeper equality check —
    // doesn't address the underlying semantics.)
  }, [currentValue]);

  const setValue = useCallback(
    (next: T): void => {
      lastCommitIdRef.current += 1;
      const commitId = lastCommitIdRef.current;
      // Snapshot the value the operator is rolling back TO if this
      // commit fails — the value VISIBLE BEFORE this `setValue`.
      const prior: T = optimistic.set ? optimistic.value : currentValue;
      priorForLatestCommitRef.current = prior;

      // Flip local state immediately — this is the optimistic step.
      setOptimistic({ set: true, value: next });
      setSaving(true);
      setLastError(null);
      inFlightCountRef.current += 1;

      void (async (): Promise<void> => {
        try {
          await applyFnRef.current(next);
          inFlightCountRef.current -= 1;
          if (commitId !== lastCommitIdRef.current) {
            // A newer setValue has already moved the world on.
            // Don't touch optimistic value or saving/lastError —
            // those belong to the newer commit. The newer commit's
            // settle path will clear saving when it resolves.
            return;
          }
          // Latest commit, success: clear saving. Leave the
          // optimistic value as-is; it already matches what we
          // committed. (`currentValue` will catch up on the next
          // parent render and the no-commit-in-flight effect
          // above will drop the latch.)
          setSaving(false);
          setLastError(null);
        } catch (err) {
          inFlightCountRef.current -= 1;
          if (commitId !== lastCommitIdRef.current) {
            // Stale failure — a newer commit superseded this one
            // before it failed. The operator's latest intent
            // (the newer commit) is the one we honor; the
            // stale failure is silently dropped from the UX
            // surface. No rollback, no toast.
            return;
          }
          // Latest commit, failure: rollback to the value the
          // operator saw just before they fired this commit.
          const error = err instanceof Error ? err : new Error(String(err));
          setOptimistic({ set: true, value: priorForLatestCommitRef.current });
          setSaving(false);
          setLastError(error);
          const toast = rollbackToastRef.current;
          if (toast !== undefined) {
            toast(err);
          }
        }
      })();
    },
    // `currentValue` + `optimistic` are read INSIDE setValue to
    // capture the operator's just-before-click view. React's
    // `useCallback` will rebuild the closure on every change to
    // either — that's intentional, the closure has to read the
    // current state.
    [currentValue, optimistic.set, optimistic.value],
  );

  return {
    value: optimistic.set ? optimistic.value : currentValue,
    setValue,
    saving,
    lastError,
  };
}
