/**
 * `useOptimisticPatch` hook tests — PR-B5 (wave-16, phase-a
 * appendix #16).
 *
 * Pins the contract:
 *   1. `setValue(next)` flips local state IMMEDIATELY (optimistic).
 *   2. `saving` flips to `true` while `applyFn` is in flight.
 *   3. On `applyFn` success: state stays at `next`, `saving` flips
 *      to `false`, `lastError` stays `null`, no rollback toast.
 *   4. On `applyFn` rejection: state reverts to the prior value,
 *      `saving` flips to `false`, `lastError` holds the error,
 *      `rollbackToast` callback (if supplied) fires with the error.
 *   5. Strict-mode double-invocation safe: a `useRef` tracks the
 *      latest commit so React 19 dev double-effects don't trigger
 *      a stale rollback.
 *   6. `currentValue` prop changes propagate when the hook is NOT
 *      mid-flight (parent refresh after PATCH lands).
 *   7. Successive `setValue` calls overlap correctly — a faster
 *      second call's commit wins over a slower first call's
 *      rollback (no stale rollback to an in-between value).
 */
import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useOptimisticPatch } from "../../src/hooks/useOptimisticPatch.js";

/** Test harness: mounts the hook and exposes setValue + the
 *  current state to the test via DOM. */
function Harness(props: {
  readonly initial: string;
  readonly applyFn: (next: string) => Promise<string>;
  readonly rollbackToast?: (err: unknown) => void;
}): JSX.Element {
  const [current, setCurrent] = useState(props.initial);
  const opts = props.rollbackToast
    ? { rollbackToast: props.rollbackToast }
    : {};
  const optimistic = useOptimisticPatch<string>(current, props.applyFn, opts);
  return (
    <div>
      <output data-testid="value">{optimistic.value}</output>
      <output data-testid="saving">{optimistic.saving ? "yes" : "no"}</output>
      <output data-testid="error">
        {optimistic.lastError !== null ? optimistic.lastError.message : "none"}
      </output>
      <button
        type="button"
        data-testid="set-next"
        onClick={(): void => optimistic.setValue("next")}
      >
        set next
      </button>
      <button
        type="button"
        data-testid="set-later"
        onClick={(): void => optimistic.setValue("later")}
      >
        set later
      </button>
      <button
        type="button"
        data-testid="parent-refresh"
        onClick={(): void => setCurrent("parent-refresh")}
      >
        parent refresh
      </button>
    </div>
  );
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (err: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useOptimisticPatch", () => {
  it("setValue(next) immediately reflects in state", () => {
    const d = defer<string>();
    render(
      <Harness
        initial="initial"
        applyFn={async (): Promise<string> => d.promise}
      />,
    );
    expect(screen.getByTestId("value").textContent).toBe("initial");
    expect(screen.getByTestId("saving").textContent).toBe("no");
    fireEvent.click(screen.getByTestId("set-next"));
    expect(screen.getByTestId("value").textContent).toBe("next");
    expect(screen.getByTestId("saving").textContent).toBe("yes");
    expect(screen.getByTestId("error").textContent).toBe("none");
  });

  it("on success: state stays at next, saving=false, lastError null, no rollback toast", async () => {
    const rollbackToast = vi.fn();
    const applyFn = vi.fn(async (next: string): Promise<string> => next);
    render(
      <Harness
        initial="initial"
        applyFn={applyFn}
        rollbackToast={rollbackToast}
      />,
    );
    await act(async (): Promise<void> => {
      fireEvent.click(screen.getByTestId("set-next"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("value").textContent).toBe("next");
    expect(screen.getByTestId("saving").textContent).toBe("no");
    expect(screen.getByTestId("error").textContent).toBe("none");
    expect(applyFn).toHaveBeenCalledOnce();
    expect(applyFn).toHaveBeenCalledWith("next");
    expect(rollbackToast).not.toHaveBeenCalled();
  });

  it("on failure: state reverts to prior, saving=false, lastError set, rollbackToast called", async () => {
    const rollbackToast = vi.fn();
    const err = new Error("boom");
    const applyFn = vi.fn(async (): Promise<string> => {
      throw err;
    });
    render(
      <Harness
        initial="initial"
        applyFn={applyFn}
        rollbackToast={rollbackToast}
      />,
    );
    await act(async (): Promise<void> => {
      fireEvent.click(screen.getByTestId("set-next"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("value").textContent).toBe("initial");
    expect(screen.getByTestId("saving").textContent).toBe("no");
    expect(screen.getByTestId("error").textContent).toBe("boom");
    expect(rollbackToast).toHaveBeenCalledOnce();
    expect(rollbackToast).toHaveBeenCalledWith(err);
  });

  it("strict-mode double-invocation safe: no stale rollback", async () => {
    const rollbackToast = vi.fn();
    const applyFn = vi.fn(async (next: string): Promise<string> => next);
    render(
      <StrictMode>
        <Harness
          initial="initial"
          applyFn={applyFn}
          rollbackToast={rollbackToast}
        />
      </StrictMode>,
    );
    await act(async (): Promise<void> => {
      fireEvent.click(screen.getByTestId("set-next"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("value").textContent).toBe("next");
    expect(screen.getByTestId("saving").textContent).toBe("no");
    expect(rollbackToast).not.toHaveBeenCalled();
  });

  it("propagates `currentValue` changes when not mid-flight (parent refresh after PATCH lands)", async () => {
    const applyFn = vi.fn(async (next: string): Promise<string> => next);
    render(<Harness initial="initial" applyFn={applyFn} />);
    await act(async (): Promise<void> => {
      fireEvent.click(screen.getByTestId("parent-refresh"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("value").textContent).toBe("parent-refresh");
    expect(screen.getByTestId("saving").textContent).toBe("no");
  });

  it("does not rollback to a stale prior when a second setValue lands while the first is in flight", async () => {
    const calls: Array<Deferred<string>> = [];
    const applyFn = vi.fn(async (next: string): Promise<string> => {
      const d = defer<string>();
      calls.push(d);
      return d.promise.then(() => next);
    });
    render(<Harness initial="initial" applyFn={applyFn} />);
    fireEvent.click(screen.getByTestId("set-next"));
    fireEvent.click(screen.getByTestId("set-later"));
    expect(screen.getByTestId("value").textContent).toBe("later");
    expect(calls).toHaveLength(2);
    await act(async (): Promise<void> => {
      calls[1]!.resolve("later");
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async (): Promise<void> => {
      calls[0]!.resolve("next");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("value").textContent).toBe("later");
    expect(screen.getByTestId("saving").textContent).toBe("no");
  });

  it("rollback after a stale first failure does NOT clobber a successful second commit", async () => {
    const calls: Array<Deferred<string>> = [];
    const applyFn = vi.fn(async (next: string): Promise<string> => {
      const d = defer<string>();
      calls.push(d);
      return d.promise.then(() => next);
    });
    const rollbackToast = vi.fn();
    render(
      <Harness
        initial="initial"
        applyFn={applyFn}
        rollbackToast={rollbackToast}
      />,
    );
    fireEvent.click(screen.getByTestId("set-next"));
    fireEvent.click(screen.getByTestId("set-later"));
    await act(async (): Promise<void> => {
      calls[1]!.resolve("later");
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async (): Promise<void> => {
      calls[0]!.reject(new Error("late-failure"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("value").textContent).toBe("later");
    expect(rollbackToast).not.toHaveBeenCalled();
  });
});
