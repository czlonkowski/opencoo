/**
 * useLiveValidation tests — wave-16 PR-B4.
 *
 * Pins the contract:
 *   - Sync validators run on every value change.
 *   - Async validators debounce 250ms; the latest call wins
 *     (older in-flight requests are aborted via AbortController).
 *   - State machine: idle → validating → valid|invalid.
 *   - Multiple async validators in flight don't cross-contaminate.
 *
 * The hook is a pure React hook — these tests use renderHook +
 * a manual rerender pattern (no DOM, no modal wiring).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useLiveValidation } from "../../src/hooks/useLiveValidation.js";

interface SampleValues extends Record<string, string> {
  readonly slug: string;
  readonly name: string;
}

const INITIAL: SampleValues = { slug: "", name: "" };

describe("useLiveValidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts every field in idle when no validation has run yet", () => {
    const { result } = renderHook(() =>
      useLiveValidation<SampleValues>(INITIAL, {
        slug: (v) => (v.length > 0 ? null : "required"),
        name: (v) => (v.length > 0 ? null : "required"),
      }),
    );
    expect(result.current.slug.status).toBe("idle");
    expect(result.current.slug.message).toBeNull();
    expect(result.current.name.status).toBe("idle");
  });

  it("runs sync validator on each value change synchronously", () => {
    const slugValidator = vi.fn((v: string) =>
      /^[a-z][a-z0-9-]{1,62}$/.test(v) ? null : "Slug must match",
    );
    const { result, rerender } = renderHook(
      ({ values }: { values: SampleValues }) =>
        useLiveValidation<SampleValues>(values, { slug: slugValidator }),
      { initialProps: { values: INITIAL } },
    );
    expect(result.current.slug.status).toBe("idle");

    rerender({ values: { slug: "Bad Slug", name: "" } });
    expect(slugValidator).toHaveBeenCalledWith("Bad Slug", expect.any(Object));
    expect(result.current.slug.status).toBe("invalid");
    expect(result.current.slug.message).toBe("Slug must match");

    rerender({ values: { slug: "wiki-main", name: "" } });
    expect(result.current.slug.status).toBe("valid");
    expect(result.current.slug.message).toBeNull();
  });

  it("debounces async validator by 250ms; goes idle → validating → valid", async () => {
    let resolvedWith = "";
    const asyncValidator = vi.fn(async (v: string): Promise<string | null> => {
      resolvedWith = v;
      return null;
    });
    const { result, rerender } = renderHook(
      ({ values }: { values: SampleValues }) =>
        useLiveValidation<SampleValues>(values, { slug: { async: asyncValidator } }),
      { initialProps: { values: INITIAL } },
    );
    expect(result.current.slug.status).toBe("idle");

    act(() => {
      rerender({ values: { slug: "wiki-main", name: "" } });
    });
    // Sync update: status is "validating" while the debounce + async run.
    expect(result.current.slug.status).toBe("validating");
    expect(asyncValidator).not.toHaveBeenCalled();

    // Advance to fire the debounce.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(asyncValidator).toHaveBeenCalledTimes(1);
    expect(asyncValidator.mock.calls[0]?.[0]).toBe("wiki-main");
    expect(result.current.slug.status).toBe("valid");
    expect(result.current.slug.message).toBeNull();
    expect(resolvedWith).toBe("wiki-main");
  });

  it("cancels the in-flight async validator when the value changes again", async () => {
    const seenSignals: AbortSignal[] = [];
    const asyncValidator = vi.fn(
      async (
        v: string,
        _all: SampleValues,
        signal: AbortSignal,
      ): Promise<string | null> => {
        seenSignals.push(signal);
        // Yield to the event loop so a follow-up rerender can abort.
        await new Promise((r) => setTimeout(r, 1000));
        if (signal.aborted) throw new Error("aborted");
        return v === "taken" ? "Already used" : null;
      },
    );
    const { result, rerender } = renderHook(
      ({ values }: { values: SampleValues }) =>
        useLiveValidation<SampleValues>(values, { slug: { async: asyncValidator } }),
      { initialProps: { values: INITIAL } },
    );

    act(() => {
      rerender({ values: { slug: "first", name: "" } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    // First in-flight call is now running.
    expect(asyncValidator).toHaveBeenCalledTimes(1);
    expect(seenSignals[0]?.aborted).toBe(false);

    // Operator keeps typing — cancels the first request.
    act(() => {
      rerender({ values: { slug: "second", name: "" } });
    });
    expect(seenSignals[0]?.aborted).toBe(true);

    // New debounce + new request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(asyncValidator).toHaveBeenCalledTimes(2);
    expect(asyncValidator.mock.calls[1]?.[0]).toBe("second");

    // Resolve the second.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.slug.status).toBe("valid");
  });

  it("returns 'invalid' with the validator's message when async resolves with a string", async () => {
    const asyncValidator = vi.fn(async (): Promise<string | null> => "Already taken");
    const { result, rerender } = renderHook(
      ({ values }: { values: SampleValues }) =>
        useLiveValidation<SampleValues>(values, { slug: { async: asyncValidator } }),
      { initialProps: { values: INITIAL } },
    );
    act(() => {
      rerender({ values: { slug: "wiki-main", name: "" } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(result.current.slug.status).toBe("invalid");
    expect(result.current.slug.message).toBe("Already taken");
  });

  it("two async validators in flight don't cross-contaminate", async () => {
    const slugValidator = vi.fn(async (v: string): Promise<string | null> =>
      v === "taken-slug" ? "Slug taken" : null,
    );
    const nameValidator = vi.fn(async (v: string): Promise<string | null> =>
      v === "taken-name" ? "Name taken" : null,
    );
    const { result, rerender } = renderHook(
      ({ values }: { values: SampleValues }) =>
        useLiveValidation<SampleValues>(values, {
          slug: { async: slugValidator },
          name: { async: nameValidator },
        }),
      { initialProps: { values: INITIAL } },
    );
    act(() => {
      rerender({ values: { slug: "taken-slug", name: "ok-name" } });
    });
    expect(result.current.slug.status).toBe("validating");
    expect(result.current.name.status).toBe("validating");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(slugValidator).toHaveBeenCalledTimes(1);
    expect(nameValidator).toHaveBeenCalledTimes(1);
    expect(result.current.slug.status).toBe("invalid");
    expect(result.current.slug.message).toBe("Slug taken");
    expect(result.current.name.status).toBe("valid");
    expect(result.current.name.message).toBeNull();
  });

  it("runs sync immediately even when an async validator is also present (immediate-invalid skips the async)", async () => {
    const sync = vi.fn((v: string) =>
      /^[a-z][a-z0-9-]{1,62}$/.test(v) ? null : "format-fail",
    );
    const asyncValidator = vi.fn(async (): Promise<string | null> => null);
    const { result, rerender } = renderHook(
      ({ values }: { values: SampleValues }) =>
        useLiveValidation<SampleValues>(values, {
          slug: { sync, async: asyncValidator },
        }),
      { initialProps: { values: INITIAL } },
    );
    act(() => {
      rerender({ values: { slug: "Bad Slug", name: "" } });
    });
    // Sync failed → status is invalid immediately; async never fires.
    expect(result.current.slug.status).toBe("invalid");
    expect(result.current.slug.message).toBe("format-fail");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(asyncValidator).not.toHaveBeenCalled();
  });

  it("empty value short-circuits async (don't probe the server with empty input)", async () => {
    const asyncValidator = vi.fn(async (): Promise<string | null> => null);
    const { rerender } = renderHook(
      ({ values }: { values: SampleValues }) =>
        useLiveValidation<SampleValues>(values, { slug: { async: asyncValidator } }),
      { initialProps: { values: { slug: "wiki", name: "" } } },
    );
    act(() => {
      rerender({ values: { slug: "", name: "" } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(asyncValidator).not.toHaveBeenCalled();
  });
});
