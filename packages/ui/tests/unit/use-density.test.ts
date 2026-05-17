/**
 * useDensity hook — global density preference (PR-C6, phase-a
 * appendix #16 wave-16).
 *
 * Per-device chrome preference, NOT per-account — density lives in
 * `localStorage.opencoo_density` only. No DB column, no admin route
 * (mirrors IDE themes; an operator who flips on machine A keeps
 * comfortable on machine B until they flip there too).
 *
 * Contract:
 *   - Default `comfortable` when the key is absent.
 *   - `setDensity(d)` writes localStorage + sets `<body data-density={d}>`.
 *   - On mount, the current value is also written to `<body>` so the
 *     CSS variant binds even if the operator never opens the toggle.
 *   - Round-trip: setting then re-reading returns the right value.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useDensity } from "../../src/hooks/useDensity.js";

const STORAGE_KEY = "opencoo_density";

afterEach(() => {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore — jsdom always provides localStorage.
  }
  document.body.removeAttribute("data-density");
});

describe("useDensity (PR-C6)", () => {
  it("defaults to 'comfortable' when localStorage is empty", () => {
    const { result } = renderHook(() => useDensity());
    expect(result.current.density).toBe("comfortable");
  });

  it("reads the stored value when localStorage is preset", () => {
    window.localStorage.setItem(STORAGE_KEY, "compact");
    const { result } = renderHook(() => useDensity());
    expect(result.current.density).toBe("compact");
  });

  it("sets <body data-density> to the current value on mount", () => {
    window.localStorage.setItem(STORAGE_KEY, "compact");
    renderHook(() => useDensity());
    expect(document.body.getAttribute("data-density")).toBe("compact");
  });

  it("sets <body data-density='comfortable'> on mount when storage empty", () => {
    renderHook(() => useDensity());
    expect(document.body.getAttribute("data-density")).toBe("comfortable");
  });

  it("setDensity('compact') writes localStorage and updates the body attribute", () => {
    const { result } = renderHook(() => useDensity());
    act(() => {
      result.current.setDensity("compact");
    });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("compact");
    expect(document.body.getAttribute("data-density")).toBe("compact");
    expect(result.current.density).toBe("compact");
  });

  it("round-trip: setDensity then remount returns the persisted value", () => {
    const first = renderHook(() => useDensity());
    act(() => {
      first.result.current.setDensity("compact");
    });
    first.unmount();

    const second = renderHook(() => useDensity());
    expect(second.result.current.density).toBe("compact");
    expect(document.body.getAttribute("data-density")).toBe("compact");
  });

  it("falling back from compact to comfortable persists both states", () => {
    const { result } = renderHook(() => useDensity());
    act(() => {
      result.current.setDensity("compact");
    });
    expect(result.current.density).toBe("compact");
    act(() => {
      result.current.setDensity("comfortable");
    });
    expect(result.current.density).toBe("comfortable");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("comfortable");
    expect(document.body.getAttribute("data-density")).toBe("comfortable");
  });

  it("ignores an unrecognised stored value and falls back to comfortable", () => {
    // A corrupted localStorage value (manually edited, leftover from
    // a previous build) should not propagate — the hook clamps to a
    // valid option so the CSS variant binding stays sane.
    window.localStorage.setItem(STORAGE_KEY, "ultra-cramped");
    const { result } = renderHook(() => useDensity());
    expect(result.current.density).toBe("comfortable");
    expect(document.body.getAttribute("data-density")).toBe("comfortable");
  });
});
