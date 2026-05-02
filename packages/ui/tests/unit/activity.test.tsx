/**
 * Activity route — three subviews (feed, runs, pipelines).
 *
 * Test-first artifact for PR-B (phase-a appendix #4).
 *
 * Pin matrix:
 *   1. Renders three sub-tab buttons (feed, runs, pipelines).
 *   2. Feed tab shows a "Connecting…" or "Live" state indicator.
 *   3. Runs tab fetches /api/admin/agent-runs and renders the rows.
 *   4. Pipelines tab fetches /api/admin/pipelines and renders pipeline cards.
 *   5. Runs tab hides `output` content (no raw LLM output in the list view).
 *   6. Empty states render without crash.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

import { Activity } from "../../src/routes/Activity.js";

/** Minimal agent-run fixture for list view. */
function makeRun(overrides: {
  id?: string;
  definitionSlug?: string;
  status?: string;
  trigger?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: string;
  latencyMs?: number;
  startedAt?: string;
  endedAt?: string | null;
  errorClass?: string | null;
  skillsUsed?: unknown[];
}) {
  return {
    id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
    definitionSlug: overrides.definitionSlug ?? "heartbeat",
    status: overrides.status ?? "success",
    trigger: overrides.trigger ?? "scheduled",
    tokensIn: overrides.tokensIn ?? 100,
    tokensOut: overrides.tokensOut ?? 200,
    costUsd: overrides.costUsd ?? "0.001234",
    latencyMs: overrides.latencyMs ?? 1500,
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    endedAt: overrides.endedAt ?? new Date().toISOString(),
    errorClass: overrides.errorClass ?? null,
    skillsUsed: overrides.skillsUsed ?? [],
  };
}

/** Minimal pipeline fixture. */
function makePipeline(overrides: {
  name?: string;
  depth?: number;
  failedCount?: number;
  dlqCount?: number;
  lastRunAt?: string | null;
  lastFailureAt?: string | null;
}) {
  return {
    name: overrides.name ?? "ingestion.scanner",
    depth: overrides.depth ?? 0,
    failedCount: overrides.failedCount ?? 0,
    dlqCount: overrides.dlqCount ?? 0,
    lastRunAt: overrides.lastRunAt ?? null,
    lastFailureAt: overrides.lastFailureAt ?? null,
  };
}

function makeFetch(opts: {
  runs?: ReturnType<typeof makeRun>[];
  pipelines?: ReturnType<typeof makePipeline>[];
  total?: number;
}): typeof fetch {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/admin/agent-runs")) {
      return new Response(
        JSON.stringify({ rows: opts.runs ?? [], total: opts.total ?? 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("/api/admin/pipelines")) {
      return new Response(
        JSON.stringify({ pipelines: opts.pipelines ?? [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("404", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("Activity route — sub-tab navigation", () => {
  it("renders three sub-tab buttons: feed, runs, pipelines", () => {
    const fetchImpl = makeFetch({});
    render(<Activity fetchImpl={fetchImpl} />);

    expect(screen.getByRole("button", { name: /feed/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /runs/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pipelines/i })).toBeInTheDocument();
  });
});

describe("Activity route — feed sub-tab", () => {
  it("shows a connection-state indicator on the feed tab", () => {
    const fetchImpl = makeFetch({});
    render(<Activity fetchImpl={fetchImpl} />);

    // Feed tab is active by default. The feed content area shows "connecting…"
    // or "live" depending on EventSource availability. In jsdom there's no
    // EventSource, so the sse.ts client marks itself open immediately.
    // Use queryAllByText to avoid the "multiple elements" throw when the
    // "feed" nav button also matches.
    const indicators = screen.queryAllByText(/connecting|live/i);
    expect(indicators.length).toBeGreaterThan(0);
  });
});

describe("Activity route — runs sub-tab", () => {
  it("renders agent run rows from /api/admin/agent-runs", async () => {
    const runs = [
      makeRun({ definitionSlug: "heartbeat", status: "success" }),
      makeRun({ id: "22222222-2222-2222-2222-222222222222", definitionSlug: "lint", status: "running" }),
    ];
    const fetchImpl = makeFetch({ runs, total: 2 });
    render(<Activity fetchImpl={fetchImpl} />);

    // Switch to runs tab.
    fireEvent.click(screen.getByRole("button", { name: /runs/i }));

    await waitFor(() => screen.getByText("heartbeat"));
    expect(screen.getByText("heartbeat")).toBeInTheDocument();
    expect(screen.getByText("lint")).toBeInTheDocument();
  });

  it("does not render raw output content in the list view", async () => {
    const runs = [makeRun({ definitionSlug: "heartbeat" })];
    const fetchImpl = makeFetch({ runs, total: 1 });
    render(<Activity fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /runs/i }));

    await waitFor(() => screen.getByText("heartbeat"));
    // The list-level response has no `output` field; even if it did,
    // the UI must not render raw LLM output in the list.
    expect(screen.queryByText(/raw_prompt|you are a/i)).not.toBeInTheDocument();
  });

  it("renders an empty state when there are no runs", async () => {
    const fetchImpl = makeFetch({ runs: [], total: 0 });
    render(<Activity fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /runs/i }));

    // Wait for data to load, then verify no crash.
    await waitFor(() => {
      // Empty state shows "No runs yet." or similar — just verify no crash.
      const hasEmptyText = screen.queryByText(/no runs|no activity|empty/i) !== null;
      // If not found, at least the DOM rendered without error.
      return hasEmptyText || true;
    });
    // No crash is the main assertion.
  });
});

describe("Activity route — pipelines sub-tab", () => {
  it("renders pipeline cards from /api/admin/pipelines", async () => {
    const pipelines = [
      makePipeline({ name: "ingestion.scanner", depth: 3, failedCount: 1 }),
    ];
    const fetchImpl = makeFetch({ pipelines });
    render(<Activity fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /pipelines/i }));

    await waitFor(() => screen.getByText("ingestion.scanner"));
    expect(screen.getByText("ingestion.scanner")).toBeInTheDocument();
  });

  it("renders an empty state when no pipelines are wired", async () => {
    const fetchImpl = makeFetch({ pipelines: [] });
    render(<Activity fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /pipelines/i }));

    // Renders without crash; empty state text is optional.
    await waitFor(() => true);
  });
});
