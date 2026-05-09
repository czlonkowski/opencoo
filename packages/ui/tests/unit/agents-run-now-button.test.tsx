/**
 * AgentsRunNowButton — "Run now" / "Refresh now" / "Re-run lint"
 * CTA (PR-R3, phase-a appendix #10).
 *
 * Pin matrix:
 *   1. Idle → click → "Queued · Ns" label with the heartbeat
 *      pulse glyph.
 *   2. SSE-driven status updates: button text flips to "Running"
 *      then back to idle on success.
 *   3. 429 response → tooltip with Retry-After value.
 *   4. The heartbeat-pulse glyph is the ONLY motion loop on the
 *      button — assert no other CSS animation declarations are
 *      emitted.
 *   5. Disabled while queued/running so a runaway click can't
 *      double-fire.
 */
import { describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { AgentsRunNowButton } from "../../src/components/AgentsRunNowButton.js";
import { setPat } from "../../src/lib/pat-store.js";

type SseEvent = {
  runId: string;
  definitionSlug: string;
  status: string;
};

interface SubFactory {
  subscribe: (
    listener: (evt: SseEvent) => void,
  ) => () => void;
  emit(evt: SseEvent): void;
}

function makeSubscribe(): SubFactory {
  let listenerRef: ((e: SseEvent) => void) | null = null;
  return {
    subscribe(listener) {
      listenerRef = listener;
      return (): void => {
        if (listenerRef === listener) listenerRef = null;
      };
    },
    emit(evt) {
      if (listenerRef !== null) listenerRef(evt);
    },
  };
}

function make200Fetch(jobId = "job-1"): typeof fetch {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/admin/agents/")) {
      return new Response(
        JSON.stringify({
          jobId,
          agentSlug: "lint",
          domainSlug: "wiki-exec",
          instanceSlug: "lint-default",
          dryRun: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/admin/_csrf")) {
      return new Response(JSON.stringify({ csrfToken: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

function make429Fetch(retryAfterSec = 42): typeof fetch {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/admin/agents/")) {
      return new Response(
        JSON.stringify({ error: "rate_limited", retryAfterSec }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/admin/_csrf")) {
      return new Response(JSON.stringify({ csrfToken: "tok" }), {
        status: 200,
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("AgentsRunNowButton — idle → click → queued", () => {
  it("renders the idle label by default", () => {
    setPat("test-pat");
    const sub = makeSubscribe();
    render(
      <AgentsRunNowButton
        agentSlug="lint"
        domainSlug="wiki-exec"
        idleLabel="Re-run lint"
        queuedLabelFormat="Queued · {sec}s"
        runningLabelFormat="Running · {sec}s"
        rateLimitedTooltipFormat="Rate limited — try again in {sec}s"
        subscribeToAgentRuns={sub.subscribe}
        fetchImpl={make200Fetch()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Re-run lint/i }),
    ).toBeInTheDocument();
  });

  it("on click flips to Queued · 0s with the heartbeat-pulse glyph", async () => {
    setPat("test-pat");
    const sub = makeSubscribe();
    render(
      <AgentsRunNowButton
        agentSlug="lint"
        domainSlug="wiki-exec"
        idleLabel="Re-run lint"
        queuedLabelFormat="Queued · {sec}s"
        runningLabelFormat="Running · {sec}s"
        rateLimitedTooltipFormat="Rate limited — try again in {sec}s"
        subscribeToAgentRuns={sub.subscribe}
        fetchImpl={make200Fetch()}
      />,
    );
    const btn = screen.getByRole("button", { name: /Re-run lint/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn.getAttribute("data-state")).toBe("queued");
    });
    expect(btn.textContent).toMatch(/Queued/);
    // The heartbeat-pulse glyph is the ONLY motion loop on the
    // button. The class drives the `opencoo-heartbeat` keyframe
    // declared in `styles/app.css`.
    const glyph = screen.getByTestId("agents-run-now-heartbeat");
    expect(glyph.classList.contains("heartbeat-glyph")).toBe(true);
    // The button itself must NOT carry any animation property
    // (we explicitly assert NO other motion loops exist).
    expect(btn.style.animation).toBe("");
    expect(btn.style.animationName).toBe("");
  });
});

describe("AgentsRunNowButton — SSE-driven state transitions", () => {
  it("flips queued → running → done on lifecycle events", async () => {
    setPat("test-pat");
    const sub = makeSubscribe();
    render(
      <AgentsRunNowButton
        agentSlug="lint"
        domainSlug="wiki-exec"
        idleLabel="Re-run lint"
        queuedLabelFormat="Queued · {sec}s"
        runningLabelFormat="Running · {sec}s"
        rateLimitedTooltipFormat="Rate limited — try again in {sec}s"
        subscribeToAgentRuns={sub.subscribe}
        fetchImpl={make200Fetch()}
      />,
    );
    const btn = screen.getByRole("button", { name: /Re-run lint/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn.getAttribute("data-state")).toBe("queued");
    });

    // Emit a `running` SSE event for the matching agent slug.
    act(() => {
      sub.emit({
        runId: "abc-123",
        definitionSlug: "lint",
        status: "running",
      });
    });
    await waitFor(() => {
      expect(btn.getAttribute("data-state")).toBe("running");
    });
    expect(btn.textContent).toMatch(/Running/);

    // Emit `success` → button transitions to `done` (briefly)
    // then reverts to idle. The done-glyph is rendered while in
    // the done state.
    act(() => {
      sub.emit({
        runId: "abc-123",
        definitionSlug: "lint",
        status: "success",
      });
    });
    await waitFor(() => {
      expect(btn.getAttribute("data-state")).toBe("done");
    });
    expect(screen.getByTestId("agents-run-now-done")).toBeInTheDocument();
  });

  it("ignores SSE events for a different agent slug", async () => {
    setPat("test-pat");
    const sub = makeSubscribe();
    render(
      <AgentsRunNowButton
        agentSlug="lint"
        domainSlug="wiki-exec"
        idleLabel="Re-run lint"
        queuedLabelFormat="Queued · {sec}s"
        runningLabelFormat="Running · {sec}s"
        rateLimitedTooltipFormat="Rate limited — try again in {sec}s"
        subscribeToAgentRuns={sub.subscribe}
        fetchImpl={make200Fetch()}
      />,
    );
    const btn = screen.getByRole("button", { name: /Re-run lint/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn.getAttribute("data-state")).toBe("queued");
    });
    // A heartbeat run finishing must NOT flip our lint button.
    act(() => {
      sub.emit({
        runId: "other-1",
        definitionSlug: "heartbeat",
        status: "success",
      });
    });
    // Stays queued; data-state is unchanged.
    expect(btn.getAttribute("data-state")).toBe("queued");
  });
});

describe("AgentsRunNowButton — 429 rate-limit", () => {
  it("renders a tooltip with the retry-after value", async () => {
    setPat("test-pat");
    const sub = makeSubscribe();
    render(
      <AgentsRunNowButton
        agentSlug="lint"
        domainSlug="wiki-exec"
        idleLabel="Re-run lint"
        queuedLabelFormat="Queued · {sec}s"
        runningLabelFormat="Running · {sec}s"
        rateLimitedTooltipFormat="Rate limited — try again in {sec}s"
        subscribeToAgentRuns={sub.subscribe}
        fetchImpl={make429Fetch(99)}
      />,
    );
    const btn = screen.getByRole("button", { name: /Re-run lint/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn.getAttribute("data-rate-limited-sec")).toBe("99");
    });
    expect(btn.getAttribute("title")).toMatch(/99/);
    expect(btn.getAttribute("title")).toMatch(/Rate limited/);
    // Reverts to idle so the operator can try again later.
    expect(btn.getAttribute("data-state")).toBe("idle");
  });
});

describe("AgentsRunNowButton — disabled state", () => {
  it("button is disabled while queued so a runaway click can't double-fire", async () => {
    setPat("test-pat");
    const sub = makeSubscribe();
    let calls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/admin/agents/")) {
        calls += 1;
        // Resolve slowly so the button stays in `queued`.
        await new Promise((r) => setTimeout(r, 50));
        return new Response(
          JSON.stringify({
            jobId: `job-${calls}`,
            agentSlug: "lint",
            domainSlug: "wiki-exec",
            instanceSlug: "lint-default",
            dryRun: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <AgentsRunNowButton
        agentSlug="lint"
        domainSlug="wiki-exec"
        idleLabel="Re-run lint"
        queuedLabelFormat="Queued · {sec}s"
        runningLabelFormat="Running · {sec}s"
        rateLimitedTooltipFormat="Rate limited — try again in {sec}s"
        subscribeToAgentRuns={sub.subscribe}
        fetchImpl={fetchImpl}
      />,
    );
    const btn = screen.getByRole("button", { name: /Re-run lint/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn.getAttribute("data-state")).toBe("queued");
    });
    // Fire 3 more clicks; only the first should produce a fetch.
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(1);
  });
});
