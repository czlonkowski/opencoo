/**
 * Toast queue + useToast hook tests — PR-B7 (wave-16, phase-a
 * appendix #16).
 *
 * Pins the load-bearing invariants:
 *   - Three tones: success / advisory / alert. Each renders a
 *     left-border in the matching design-system accent token
 *     (`--healthy` / `--advisory` / `--alert`) + a JetBrains
 *     Mono tone-tag (OK / ADVISORY / ALERT).
 *   - Default auto-dismiss at 6000ms (fake timers).
 *   - Hover-pause: dwell pauses the timer; resume picks up where
 *     it paused, not from zero.
 *   - Sticky toasts never auto-dismiss.
 *   - Details collapsed by default; click "Show details" expands
 *     a pre-formatted mono `<pre>` body.
 *   - ARIA: `alert` tone → `role="alert"`; `success`/`advisory` →
 *     `role="status"`. The region itself carries `role="region"`
 *     + `aria-label={t('toast.region')}`.
 *   - No emoji in any rendered DOM string.
 *   - Cleanup: unmounting `<ToastRegion>` clears all pending
 *     timers (setState on an unmounted component would throw).
 */
import { act } from "react";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import {
  ToastRegion,
  ToastProvider,
  useToast,
} from "../../src/components/Toast.js";
import {
  LiveRegions,
  POLITE_REGION_ID,
  ASSERTIVE_REGION_ID,
} from "../../src/components/LiveRegions.js";
import { __resetAnnouncementsForTests } from "../../src/lib/announce.js";

/** Caller-side helper: render a button that invokes a toast
 *  method when clicked. Lets the tests drive the hook through
 *  the same shape consumers will use, without requiring a custom
 *  test-only `act()` wrapper. */
function Harness(props: {
  readonly fire: (api: ReturnType<typeof useToast>) => void;
}): JSX.Element {
  const api = useToast();
  return (
    <button type="button" onClick={(): void => props.fire(api)}>
      fire
    </button>
  );
}

function renderWithProvider(node: JSX.Element): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      {node}
      <ToastRegion />
    </ToastProvider>,
  );
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;

describe("ToastRegion ARIA + mounting", () => {
  it("renders a region landmark with the i18n label", () => {
    renderWithProvider(<Harness fire={(api): void => api.success("hi")} />);
    const region = screen.getByRole("region", { name: /notifications/i });
    expect(region).not.toBeNull();
  });

  it("renders nothing inside the region when no toasts are pending", () => {
    renderWithProvider(<Harness fire={(api): void => api.success("hi")} />);
    const region = screen.getByRole("region", { name: /notifications/i });
    expect(region.textContent).toBe("");
  });

  it("includes no emoji in the rendered region (mounted or empty)", () => {
    renderWithProvider(
      <Harness fire={(api): void => api.alert({ message: "boom" })} />,
    );
    fireEvent.click(screen.getByText("fire"));
    const region = screen.getByRole("region", { name: /notifications/i });
    expect(EMOJI_RE.test(region.textContent ?? "")).toBe(false);
  });
});

describe("useToast — tone semantics", () => {
  it("success renders role=status + healthy border + OK tag", () => {
    renderWithProvider(
      <Harness fire={(api): void => api.success("saved")} />,
    );
    fireEvent.click(screen.getByText("fire"));
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("saved");
    expect((toast as HTMLElement).style.borderLeft).toContain("var(--healthy)");
    // Tone-tag — JetBrains Mono micro label.
    expect(within(toast).getByText("OK")).toBeTruthy();
  });

  it("advisory renders role=status + advisory border + ADVISORY tag", () => {
    renderWithProvider(
      <Harness fire={(api): void => api.advisory("heads up")} />,
    );
    fireEvent.click(screen.getByText("fire"));
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("heads up");
    expect((toast as HTMLElement).style.borderLeft).toContain(
      "var(--advisory)",
    );
    expect(within(toast).getByText("ADVISORY")).toBeTruthy();
  });

  it("alert renders role=alert + alert border + ALERT tag", () => {
    renderWithProvider(
      <Harness fire={(api): void => api.alert("oops")} />,
    );
    fireEvent.click(screen.getByText("fire"));
    const toast = screen.getByRole("alert");
    expect(toast.textContent).toContain("oops");
    expect((toast as HTMLElement).style.borderLeft).toContain("var(--alert)");
    expect(within(toast).getByText("ALERT")).toBeTruthy();
  });

  it("accepts a string OR an opts object with message + details + duration + sticky", () => {
    renderWithProvider(
      <Harness
        fire={(api): void =>
          api.alert({
            message: "validation failed",
            details: "name: must be ≤100 chars\nemail: invalid",
          })
        }
      />,
    );
    fireEvent.click(screen.getByText("fire"));
    const toast = screen.getByRole("alert");
    expect(toast.textContent).toContain("validation failed");
    // Details collapsed by default — the <pre> is not in the DOM yet.
    expect(toast.querySelector("pre")).toBeNull();
  });
});

describe("useToast — details expand", () => {
  it("details collapsed by default; clicking 'Show details' expands a mono <pre>", () => {
    renderWithProvider(
      <Harness
        fire={(api): void =>
          api.alert({
            message: "could not save",
            details: "name: must be ≤100 chars",
          })
        }
      />,
    );
    fireEvent.click(screen.getByText("fire"));
    const toast = screen.getByRole("alert");
    expect(toast.querySelector("pre")).toBeNull();
    const showBtn = within(toast).getByRole("button", { name: /details/i });
    fireEvent.click(showBtn);
    const pre = toast.querySelector("pre") as HTMLPreElement;
    expect(pre).not.toBeNull();
    expect(pre.textContent).toContain("must be ≤100 chars");
    expect(pre.style.fontFamily).toContain("var(--font-mono)");
  });

  it("renders no Show details button when no details are provided", () => {
    renderWithProvider(
      <Harness fire={(api): void => api.alert("plain alert")} />,
    );
    fireEvent.click(screen.getByText("fire"));
    const toast = screen.getByRole("alert");
    expect(within(toast).queryByRole("button", { name: /details/i })).toBeNull();
  });
});

describe("useToast — auto-dismiss + hover pause", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-dismisses after the default 6000ms", () => {
    renderWithProvider(
      <Harness fire={(api): void => api.success("saved")} />,
    );
    fireEvent.click(screen.getByText("fire"));
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("honours a custom durationMs", () => {
    renderWithProvider(
      <Harness
        fire={(api): void =>
          api.success({ message: "saved", durationMs: 1200 })
        }
      />,
    );
    fireEvent.click(screen.getByText("fire"));
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1199);
    });
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("pauses the timer on mouse-enter and resumes from where it paused on mouse-leave", () => {
    renderWithProvider(
      <Harness fire={(api): void => api.success("saved")} />,
    );
    fireEvent.click(screen.getByText("fire"));
    const toast = screen.getByRole("status");
    // 4s elapse — 2s remaining.
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    // Hover — pause.
    fireEvent.mouseEnter(toast);
    // Even after 10s of hover, the toast must still be present.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByRole("status")).not.toBeNull();
    // Leave — resume from the 2s remainder.
    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(screen.queryByRole("status")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("pauses on focus and resumes on blur", () => {
    renderWithProvider(
      <Harness fire={(api): void => api.success("saved")} />,
    );
    fireEvent.click(screen.getByText("fire"));
    const toast = screen.getByRole("status");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    fireEvent.focus(toast);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.queryByRole("status")).not.toBeNull();
    fireEvent.blur(toast);
    act(() => {
      vi.advanceTimersByTime(3001);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not resume the timer when focus moves between descendants (focusout bubble)", () => {
    // `onBlur` bubbles in React (focusout); moving focus between
    // descendants (e.g. Dismiss → Show details) would otherwise
    // fire a spurious blur + immediate focus pair and resume the
    // timer mid-interaction. The fix is to gate on
    // `relatedTarget`: only resume when focus has left the toast.
    // (Copilot triage on PR-B7.)
    renderWithProvider(
      <Harness
        fire={(api): void =>
          api.alert({
            message: "boom",
            details: "name: too long",
            sticky: false,
            durationMs: 6000,
          })
        }
      />,
    );
    fireEvent.click(screen.getByText("fire"));
    const toast = screen.getByRole("alert");
    const dismissBtn = within(toast).getByRole("button", { name: /dismiss/i });
    const detailsBtn = within(toast).getByRole("button", { name: /details/i });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // Focus enters via the dismiss button — pause armed.
    fireEvent.focus(dismissBtn);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByRole("alert")).not.toBeNull();
    // Move focus from Dismiss → Details (both inside the toast).
    // The bubbled blur on the <li> carries `relatedTarget =
    // detailsBtn`, which is contained in the toast — no resume.
    fireEvent.blur(dismissBtn, { relatedTarget: detailsBtn });
    fireEvent.focus(detailsBtn, { relatedTarget: dismissBtn });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // Toast must still be present — the focus shuffle inside it
    // did not resume the timer.
    expect(screen.queryByRole("alert")).not.toBeNull();
    // Focus leaves the toast entirely — resume.
    fireEvent.blur(detailsBtn, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(4001);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sticky toasts never auto-dismiss", () => {
    renderWithProvider(
      <Harness
        fire={(api): void =>
          api.alert({ message: "catastrophic", sticky: true })
        }
      />,
    );
    fireEvent.click(screen.getByText("fire"));
    expect(screen.queryByRole("alert")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByRole("alert")).not.toBeNull();
  });

  it("dismiss button removes the toast immediately", () => {
    renderWithProvider(
      <Harness
        fire={(api): void =>
          api.alert({ message: "boom", sticky: true })
        }
      />,
    );
    fireEvent.click(screen.getByText("fire"));
    const toast = screen.getByRole("alert");
    const dismiss = within(toast).getByRole("button", { name: /dismiss/i });
    fireEvent.click(dismiss);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ToastRegion — cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("unmounting the region clears all pending timers (no late setState)", () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]): void => {
      errors.push(args);
    };
    try {
      const { unmount } = renderWithProvider(
        <Harness fire={(api): void => api.success("saved")} />,
      );
      fireEvent.click(screen.getByText("fire"));
      unmount();
      // Advancing past the auto-dismiss would fire setState on an
      // unmounted tree if cleanup didn't clear the timer; the test
      // observer below captures the React warning.
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      const stateUpdateWarnings = errors.filter((args) =>
        String((args as unknown[])[0] ?? "").includes(
          "Can't perform a React state update",
        ),
      );
      expect(stateUpdateWarnings).toHaveLength(0);
    } finally {
      console.error = orig;
    }
  });
});

describe("Toast → pushAnnouncement bridge (PR-A4)", () => {
  beforeEach(() => {
    __resetAnnouncementsForTests();
  });
  afterEach(() => {
    __resetAnnouncementsForTests();
  });

  it("success toast pushes a POLITE announcement with the same text", () => {
    render(
      <ToastProvider>
        <LiveRegions />
        <Harness fire={(api): void => api.success("saved")} />
        <ToastRegion />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    const polite = document.getElementById(POLITE_REGION_ID) as HTMLElement;
    const assertive = document.getElementById(
      ASSERTIVE_REGION_ID,
    ) as HTMLElement;
    expect(polite.textContent).toContain("saved");
    expect(assertive.textContent).toBe("");
  });

  it("advisory toast pushes a POLITE announcement", () => {
    render(
      <ToastProvider>
        <LiveRegions />
        <Harness fire={(api): void => api.advisory("heads up")} />
        <ToastRegion />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    const polite = document.getElementById(POLITE_REGION_ID) as HTMLElement;
    expect(polite.textContent).toContain("heads up");
  });

  it("alert toast pushes an ASSERTIVE announcement", () => {
    render(
      <ToastProvider>
        <LiveRegions />
        <Harness fire={(api): void => api.alert("boom")} />
        <ToastRegion />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    const assertive = document.getElementById(
      ASSERTIVE_REGION_ID,
    ) as HTMLElement;
    const polite = document.getElementById(POLITE_REGION_ID) as HTMLElement;
    expect(assertive.textContent).toContain("boom");
    expect(polite.textContent).toBe("");
  });

  it("opts-form toast (message only) also bridges to the live region", () => {
    render(
      <ToastProvider>
        <LiveRegions />
        <Harness
          fire={(api): void =>
            api.alert({ message: "validation failed", details: "name: too long" })
          }
        />
        <ToastRegion />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    const assertive = document.getElementById(
      ASSERTIVE_REGION_ID,
    ) as HTMLElement;
    // Message is announced, details are NOT (they ride a collapsed
    // pre in the visual toast and would be too long to narrate as
    // a single utterance).
    expect(assertive.textContent).toContain("validation failed");
    expect(assertive.textContent).not.toContain("name: too long");
  });
});

describe("Toast — design-system hard-nos", () => {
  it("no animation loop on the toast (one-shot only)", () => {
    renderWithProvider(
      <Harness fire={(api): void => api.success("saved")} />,
    );
    fireEvent.click(screen.getByText("fire"));
    const toast = screen.getByRole("status");
    // No inline animation: the design-system "exactly one loop"
    // rule reserves animation for the heartbeat-pulse glyph.
    // Mount/dismiss is a one-shot ease-out; we render via the
    // global transition tokens (--ease-write) — never via an
    // `animation:` loop. Pin no inline animation attribute.
    expect((toast as HTMLElement).style.animation).toBe("");
    expect((toast as HTMLElement).style.animationName).toBe("");
  });

  it("no emoji in any tone-tag string", () => {
    renderWithProvider(
      <Harness fire={(api): void => api.advisory("heads up")} />,
    );
    fireEvent.click(screen.getByText("fire"));
    const toast = screen.getByRole("status");
    expect(EMOJI_RE.test(toast.textContent ?? "")).toBe(false);
  });
});
