/**
 * Reports route — Heartbeat reader + Redaction events.
 *
 * Test-first artifact for PR-D (phase-a appendix #4).
 *
 * Pin matrix:
 *   1. Renders two sub-tab buttons: heartbeat + redaction-events.
 *   2. Heartbeat sub-tab fetches /api/admin/heartbeat and renders reports.
 *   3. Heartbeat report shows summary + alerts (never raw LLM call output).
 *   4. Redaction events sub-tab fetches /api/admin/redaction-events.
 *   5. Redaction events renders category, guardSlug, matchedByteRangesCount.
 *   6. Redaction events NEVER renders matchedByteRanges content.
 *   7. Empty states render without crash.
 *   8. Heartbeat run_id is rendered as a deep-link reference.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

import { Reports } from "../../src/routes/Reports.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeHeartbeatReport(overrides: {
  runId?: string;
  instanceName?: string | null;
  startedAt?: string | null;
  output?: {
    version?: string;
    summary?: string;
    alerts?: Array<{ priority: number; title: string; body: string; citations: string[] }>;
  };
}) {
  return {
    runId: overrides.runId ?? "11111111-1111-1111-1111-111111111111",
    instanceId: null,
    instanceName: overrides.instanceName ?? "heartbeat-executive",
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    output: {
      version: overrides.output?.version ?? "v1",
      summary: overrides.output?.summary ?? "All systems nominal.",
      alerts: overrides.output?.alerts ?? [],
    },
  };
}

function makeRedactionEvent(overrides: {
  id?: string;
  pipeline?: string;
  guardSlug?: string;
  category?: string;
  patternVersion?: string;
  matchedByteRangesCount?: number;
  failMode?: string;
  domainId?: string | null;
  bindingId?: string | null;
  createdAt?: string;
}) {
  return {
    id: overrides.id ?? "22222222-2222-2222-2222-222222222222",
    pipeline: overrides.pipeline ?? "ingestion",
    guardSlug: overrides.guardSlug ?? "guard-redaction-regex",
    category: overrides.category ?? "pii.email",
    patternVersion: overrides.patternVersion ?? "1.0.0",
    matchedByteRangesCount: overrides.matchedByteRangesCount ?? 2,
    failMode: overrides.failMode ?? "transform",
    domainId: overrides.domainId ?? null,
    bindingId: overrides.bindingId ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

/** PR-W8 — default preconditions shape: empty deployment, nothing
 *  configured. Tests that need a specific diagnostic state pass a
 *  partial override that the helper spreads over this baseline. */
function makePreconditions(
  over: Partial<{
    heartbeatInstanceCount: number;
    enabledHeartbeatInstanceCount: number;
    instancesWithoutOutputChannels: number;
    mostRecentRun:
      | {
          startedAt: string | null;
          status: string;
          outputIsNull: boolean;
          instanceName: string | null;
        }
      | null;
    mostRecentDispatchedAt: string | null;
  }> = {},
) {
  return {
    heartbeatInstanceCount: over.heartbeatInstanceCount ?? 0,
    enabledHeartbeatInstanceCount: over.enabledHeartbeatInstanceCount ?? 0,
    instancesWithoutOutputChannels: over.instancesWithoutOutputChannels ?? 0,
    mostRecentRun: over.mostRecentRun ?? null,
    mostRecentDispatchedAt: over.mostRecentDispatchedAt ?? null,
  };
}

function makeFetch(opts: {
  reports?: ReturnType<typeof makeHeartbeatReport>[];
  events?: ReturnType<typeof makeRedactionEvent>[];
  total?: number;
  preconditions?: ReturnType<typeof makePreconditions>;
}): typeof fetch {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    // The preconditions URL is a prefix-match against `/api/admin/heartbeat`
    // too — match it FIRST so the diagnostic panel's fetch lands here, not
    // on the list endpoint. PR-W8.
    if (url.startsWith("/api/admin/heartbeat/preconditions")) {
      return new Response(
        JSON.stringify(opts.preconditions ?? makePreconditions()),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("/api/admin/heartbeat")) {
      return new Response(
        JSON.stringify({ reports: opts.reports ?? [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("/api/admin/redaction-events")) {
      return new Response(
        JSON.stringify({ events: opts.events ?? [], total: opts.total ?? 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("404", { status: 404 });
  }) as unknown as typeof fetch;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Reports route — sub-tab navigation", () => {
  it("renders two sub-tab buttons: heartbeat and redaction-events", () => {
    const fetchImpl = makeFetch({});
    render(<Reports fetchImpl={fetchImpl} />);

    expect(screen.getByRole("button", { name: /heartbeat/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /redaction/i })).toBeInTheDocument();
  });
});

describe("Reports route — heartbeat sub-tab", () => {
  it("fetches /api/admin/heartbeat and renders report summary", async () => {
    const reports = [
      makeHeartbeatReport({
        instanceName: "heartbeat-executive",
        output: { summary: "Three projects are at risk of missing Q2 deadline." },
      }),
    ];
    const fetchImpl = makeFetch({ reports });
    render(<Reports fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText(/Three projects are at risk/i));
    expect(screen.getByText(/Three projects are at risk/i)).toBeInTheDocument();
  });

  it("renders run_id as a deep-link reference", async () => {
    const runId = "deadbeef-dead-dead-dead-deadbeefcafe";
    const reports = [
      makeHeartbeatReport({ runId }),
    ];
    const fetchImpl = makeFetch({ reports });
    render(<Reports fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText(new RegExp(runId.slice(0, 8), "i")));
    expect(screen.getByText(new RegExp(runId.slice(0, 8), "i"))).toBeInTheDocument();
  });

  it("renders alerts when present", async () => {
    const reports = [
      makeHeartbeatReport({
        output: {
          summary: "Two alerts today.",
          alerts: [
            {
              priority: 1,
              title: "Project X deadline at risk",
              body: "The Q2 deadline for Project X is in 3 days with 40% completion.",
              citations: ["strategy/projects/project-x.md"],
            },
          ],
        },
      }),
    ];
    const fetchImpl = makeFetch({ reports });
    render(<Reports fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText(/Project X deadline at risk/i));
    expect(screen.getByText(/Project X deadline at risk/i)).toBeInTheDocument();
  });

  it("PR-W8: empty state shows the diagnostic panel naming the missing precondition", async () => {
    // Default preconditions (everything zero) → first row is "no
    // heartbeat instance configured", with a CTA to the Agents tab.
    // The CTA only renders when `onNavigate` is wired (App.tsx passes
    // it; tests opt in per-case).
    const fetchImpl = makeFetch({ reports: [], preconditions: makePreconditions() });
    const onNavigate = vi.fn();
    render(<Reports fetchImpl={fetchImpl} onNavigate={onNavigate} />);

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(
      await screen.findByText(/no heartbeat instance configured/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create heartbeat instance/i }),
    ).toBeInTheDocument();
  });

  it("shows instance name if available", async () => {
    const reports = [
      makeHeartbeatReport({ instanceName: "heartbeat-ops-domain" }),
    ];
    const fetchImpl = makeFetch({ reports });
    render(<Reports fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText(/heartbeat-ops-domain/i));
    expect(screen.getByText(/heartbeat-ops-domain/i)).toBeInTheDocument();
  });
});

describe("Reports route — redaction events sub-tab", () => {
  it("renders redaction events with category and count", async () => {
    const events = [
      makeRedactionEvent({ category: "pii.email", matchedByteRangesCount: 3 }),
    ];
    const fetchImpl = makeFetch({ events, total: 1 });
    render(<Reports fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /redaction/i }));

    await waitFor(() => screen.getByText(/pii\.email/i));
    expect(screen.getByText(/pii\.email/i)).toBeInTheDocument();
    // Count of matches (matchedByteRangesCount) is shown — use queryAllByText
    // because "3" can appear in other rendered values (e.g. time strings).
    const countMatches = screen.queryAllByText("3");
    expect(countMatches.length).toBeGreaterThan(0);
  });

  it("SECURITY: never renders matched byte range offsets", async () => {
    const events = [
      makeRedactionEvent({ matchedByteRangesCount: 2 }),
    ];
    const fetchImpl = makeFetch({ events });
    render(<Reports fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /redaction/i }));

    await waitFor(() => screen.getByText(/pii\.email/i));

    // The matchedByteRangesCount is shown but no raw range content.
    // The API already strips the ranges; the UI should never receive them
    // and must not render any "start"/"end" offset values from the ranges.
    expect(screen.queryByText(/matchedByteRanges/)).not.toBeInTheDocument();
    expect(screen.queryByText(/matched_byte_ranges/)).not.toBeInTheDocument();
  });

  it("renders pipeline and guardSlug for each event", async () => {
    const events = [
      makeRedactionEvent({
        pipeline: "miner",
        guardSlug: "guard-custom-pii",
      }),
    ];
    const fetchImpl = makeFetch({ events });
    render(<Reports fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /redaction/i }));

    await waitFor(() => screen.getByText(/miner/i));
    expect(screen.getByText(/miner/i)).toBeInTheDocument();
    expect(screen.getByText(/guard-custom-pii/i)).toBeInTheDocument();
  });

  it("shows empty state when no events", async () => {
    const fetchImpl = makeFetch({ events: [] });
    render(<Reports fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /redaction/i }));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(await screen.findByText(/no redaction events yet/i)).toBeInTheDocument();
  });
});

// ─── PR-W8 — diagnostic empty-state panel ────────────────────────────────────

describe("Reports route — PR-W8 heartbeat diagnostics panel", () => {
  it("surfaces disabled-instance row when an instance exists but is disabled", async () => {
    const fetchImpl = makeFetch({
      reports: [],
      preconditions: makePreconditions({
        heartbeatInstanceCount: 1,
        enabledHeartbeatInstanceCount: 0,
      }),
    });
    render(<Reports fetchImpl={fetchImpl} />);

    expect(
      await screen.findByText(/heartbeat instance exists but is disabled/i),
    ).toBeInTheDocument();
  });

  it("surfaces no-channels-bound row when the enabled instance has no output channels", async () => {
    const fetchImpl = makeFetch({
      reports: [],
      preconditions: makePreconditions({
        heartbeatInstanceCount: 1,
        enabledHeartbeatInstanceCount: 1,
        instancesWithoutOutputChannels: 1,
      }),
    });
    render(<Reports fetchImpl={fetchImpl} />);

    expect(
      await screen.findByText(/no output channels bound/i),
    ).toBeInTheDocument();
  });

  it("surfaces output-null row when the latest run completed with no output", async () => {
    const fetchImpl = makeFetch({
      reports: [],
      preconditions: makePreconditions({
        heartbeatInstanceCount: 1,
        enabledHeartbeatInstanceCount: 1,
        instancesWithoutOutputChannels: 0,
        mostRecentRun: {
          startedAt: "2026-05-14T10:00:00.000Z",
          status: "success",
          outputIsNull: true,
          instanceName: "heartbeat-exec",
        },
        mostRecentDispatchedAt: "2026-05-14T10:00:00.000Z",
      }),
    });
    const onNavigate = vi.fn();
    render(<Reports fetchImpl={fetchImpl} onNavigate={onNavigate} />);

    expect(
      await screen.findByText(/produced no output/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /view run details/i }),
    ).toBeInTheDocument();
  });

  it("surfaces runFailed row with the underlying status when the last run failed", async () => {
    const fetchImpl = makeFetch({
      reports: [],
      preconditions: makePreconditions({
        heartbeatInstanceCount: 1,
        enabledHeartbeatInstanceCount: 1,
        instancesWithoutOutputChannels: 0,
        mostRecentRun: {
          startedAt: "2026-05-14T10:00:00.000Z",
          status: "failed",
          outputIsNull: true,
          instanceName: "heartbeat-exec",
        },
        mostRecentDispatchedAt: "2026-05-14T10:00:00.000Z",
      }),
    });
    render(<Reports fetchImpl={fetchImpl} />);

    // Copilot triage on PR #148: status discrimination beats the
    // output-null check for non-success terminal states. The operator
    // should see "ended as failed", not "produced no output", because
    // the latter is the genuine pathological case (success + null).
    expect(
      await screen.findByText(/ended as failed/i),
    ).toBeInTheDocument();
  });

  it("surfaces run-in-flight advisory when the latest run is still running", async () => {
    const fetchImpl = makeFetch({
      reports: [],
      preconditions: makePreconditions({
        heartbeatInstanceCount: 1,
        enabledHeartbeatInstanceCount: 1,
        instancesWithoutOutputChannels: 0,
        mostRecentRun: {
          startedAt: "2026-05-14T10:00:00.000Z",
          status: "running",
          outputIsNull: true,
          instanceName: "heartbeat-exec",
        },
        mostRecentDispatchedAt: "2026-05-14T10:00:00.000Z",
      }),
    });
    render(<Reports fetchImpl={fetchImpl} />);

    // A running heartbeat with output=null is in-flight, not a failure
    // — the diagnostic surface must not label it "produced no output".
    expect(
      await screen.findByText(/still in progress/i),
    ).toBeInTheDocument();
  });

  it("surfaces runFailed row for timeout terminal state even when output is null", async () => {
    const fetchImpl = makeFetch({
      reports: [],
      preconditions: makePreconditions({
        heartbeatInstanceCount: 1,
        enabledHeartbeatInstanceCount: 1,
        instancesWithoutOutputChannels: 0,
        mostRecentRun: {
          startedAt: "2026-05-14T10:00:00.000Z",
          status: "timeout",
          outputIsNull: true,
          instanceName: "heartbeat-exec",
        },
        mostRecentDispatchedAt: "2026-05-14T10:00:00.000Z",
      }),
    });
    render(<Reports fetchImpl={fetchImpl} />);

    expect(
      await screen.findByText(/ended as timeout/i),
    ).toBeInTheDocument();
  });

  it("surfaces healthy state when every precondition passes but the window has no rows", async () => {
    const fetchImpl = makeFetch({
      reports: [],
      preconditions: makePreconditions({
        heartbeatInstanceCount: 1,
        enabledHeartbeatInstanceCount: 1,
        instancesWithoutOutputChannels: 0,
        mostRecentRun: {
          startedAt: "2026-05-14T10:00:00.000Z",
          status: "success",
          outputIsNull: false,
          instanceName: "heartbeat-exec",
        },
        mostRecentDispatchedAt: "2026-05-14T10:00:00.000Z",
      }),
    });
    render(<Reports fetchImpl={fetchImpl} />);

    expect(
      await screen.findByText(/heartbeat chain looks healthy/i),
    ).toBeInTheDocument();
  });

  it("CTA invokes onNavigate with the linked tab", async () => {
    const fetchImpl = makeFetch({
      reports: [],
      preconditions: makePreconditions(),
    });
    const onNavigate = vi.fn();
    render(<Reports fetchImpl={fetchImpl} onNavigate={onNavigate} />);

    const cta = await screen.findByRole("button", {
      name: /create heartbeat instance/i,
    });
    fireEvent.click(cta);
    expect(onNavigate).toHaveBeenCalledWith("agents");
  });

  it("surfaces real fetch error via safeErrorMessage when the heartbeat list 504s", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/admin/heartbeat/preconditions")) {
        return new Response(JSON.stringify(makePreconditions()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/admin/heartbeat")) {
        return new Response("upstream timed out", { status: 504 });
      }
      return new Response("404", { status: 404 });
    }) as unknown as typeof fetch;
    render(<Reports fetchImpl={fetchImpl} />);

    // The transient-error path of fetchAdmin throws an ApiTransientError
    // with `HTTP 504` as the message; safeErrorMessage just caps + scrubs.
    expect(await screen.findByText(/HTTP 504/i)).toBeInTheDocument();
    // The help line is rendered alongside the prefixed message.
    expect(
      screen.getByText(/re-check that your PAT is still valid/i),
    ).toBeInTheDocument();
  });

  it("scrubs Bearer-token bytes from a surfaced error before rendering", async () => {
    const leakyMessage =
      "fetch failed with Bearer abcdefghijklmnop1234567890 in Authorization";
    const fetchImpl = vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/admin/heartbeat/preconditions")) {
        return new Response(JSON.stringify(makePreconditions()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/admin/heartbeat")) {
        // Throw a network-style error so fetchAdmin wraps it as a
        // transient error whose .message contains the underlying string.
        throw new Error(leakyMessage);
      }
      return new Response("404", { status: 404 });
    }) as unknown as typeof fetch;
    render(<Reports fetchImpl={fetchImpl} />);

    await screen.findByText(/Could not load heartbeats/i);
    // The PAT-shaped substring must not appear in the rendered DOM.
    expect(screen.queryByText(/abcdefghijklmnop1234567890/)).not.toBeInTheDocument();
    expect(screen.getByText(/Bearer \[REDACTED\]/i)).toBeInTheDocument();
  });
});
