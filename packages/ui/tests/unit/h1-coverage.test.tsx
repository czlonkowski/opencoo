/**
 * h1 coverage — wave-16 PR-A2.
 *
 * Pins that every top-level route renders exactly ONE `<h1>` and
 * that the h1 carries `id="opencoo-page-h1"` so the
 * `<main aria-labelledby="opencoo-page-h1">` landmark resolves.
 *
 * Strategy — render each route in isolation, stub network calls
 * via either the `fetchImpl` test seam or `globalThis.fetch`, and
 * count h1s. We don't pin the text (locale keys are tested per-
 * route); we only pin "exactly one h1 with the right id".
 *
 * The Activity route uses an SSE client; mock it once.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

import { Activity } from "../../src/routes/Activity.js";
import { Agents } from "../../src/routes/Agents.js";
import { Audit } from "../../src/routes/Audit.js";
import { Cost } from "../../src/routes/Cost.js";
import { Domains } from "../../src/routes/Domains.js";
import { LlmPolicy } from "../../src/routes/LlmPolicy.js";
import { Outputs } from "../../src/routes/Outputs.js";
import { Prompts } from "../../src/routes/Prompts.js";
import { Reports } from "../../src/routes/Reports.js";
import { Review } from "../../src/routes/Review.js";
import { Sources } from "../../src/routes/Sources.js";

// Stub the SSE module the Activity route opens on mount. We don't
// need to deliver events for this test — only avoid throwing.
vi.mock("../../src/lib/sse.js", () => ({
  openSseClient: () => ({
    readyState: "open" as const,
    on: () => () => {},
    close: () => {},
  }),
}));

/** Empty-shape fetch stub that returns sensible defaults for every
 *  admin endpoint the routes touch on first render. The h1 invariant
 *  doesn't depend on loaded data — the heading lives in the route's
 *  chrome, not in any data-driven row — so empty payloads are
 *  enough to mount without crashing. */
function makeNoopFetch(): typeof fetch {
  return ((input: Parameters<typeof fetch>[0]) => {
    const url = input instanceof URL
      ? input.toString()
      : typeof input === "string"
        ? input
        : (input as Request).url;
    // Default empty rows / pipelines / etc.
    let body: unknown = { rows: [], total: 0 };
    if (url.includes("/pipelines")) body = { pipelines: [] };
    else if (url.includes("/agent-runs")) body = { rows: [], total: 0 };
    else if (url.includes("/scheduler")) body = { schedules: [] };
    else if (url.includes("/heartbeat/preconditions")) {
      // Full HeartbeatPreconditions shape — see types.ts. The
      // diagnostics panel reads `mostRecentDispatchedAt` and
      // `mostRecentRun.instanceName`; missing fields trigger
      // an "Invalid Date" render path that masks h1-coverage
      // regressions (Copilot triage on PR-A2).
      body = {
        heartbeatInstanceCount: 1,
        enabledHeartbeatInstanceCount: 1,
        instancesWithoutOutputChannels: 0,
        mostRecentRun: {
          startedAt: new Date().toISOString(),
          status: "success",
          outputIsNull: false,
          instanceName: "heartbeat-test",
        },
        mostRecentDispatchedAt: new Date().toISOString(),
      };
    } else if (url.includes("/heartbeat")) body = { reports: [] };
    else if (url.includes("/redaction-events")) body = { rows: [] };
    else if (url.includes("/audit-log")) body = { rows: [] };
    else if (url.includes("/cost-summary")) body = { rows: [], totals: {} };
    else if (url.includes("/domains")) body = { rows: [] };
    else if (url.includes("/source-bindings")) body = { rows: [] };
    else if (url.includes("/agent-instances")) body = { rows: [] };
    else if (url.includes("/output-channels")) body = { rows: [] };
    else if (url.includes("/prompts")) body = { rows: [] };
    else if (url.includes("/adapters")) body = { adapters: [] };
    else if (url.includes("/lint-findings")) body = { runs: [] };
    else if (url.includes("/automation-candidates")) body = { rows: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  // LlmPolicy doesn't expose a fetchImpl seam, so it reads
  // `globalThis.fetch`. Stub it globally to avoid a real network
  // call from `fetchAdmin`.
  vi.stubGlobal("fetch", makeNoopFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every top-level route, paired with the JSX that mounts it for
 *  this smoke. Routes that accept `fetchImpl` get the stub there;
 *  the rest fall back on the global fetch stub above. */
const ROUTES: ReadonlyArray<{ name: string; render: () => JSX.Element }> = [
  { name: "domains", render: () => <Domains fetchImpl={makeNoopFetch()} /> },
  { name: "sources", render: () => <Sources fetchImpl={makeNoopFetch()} /> },
  { name: "agents", render: () => <Agents fetchImpl={makeNoopFetch()} /> },
  { name: "outputs", render: () => <Outputs fetchImpl={makeNoopFetch()} /> },
  { name: "llmPolicy", render: () => <LlmPolicy /> },
  { name: "prompts", render: () => <Prompts fetchImpl={makeNoopFetch()} /> },
  { name: "activity", render: () => <Activity fetchImpl={makeNoopFetch()} /> },
  { name: "review", render: () => <Review fetchImpl={makeNoopFetch()} /> },
  { name: "reports", render: () => <Reports fetchImpl={makeNoopFetch()} /> },
  { name: "audit", render: () => <Audit fetchImpl={makeNoopFetch()} /> },
  { name: "cost", render: () => <Cost fetchImpl={makeNoopFetch()} /> },
];

describe("h1 coverage across every route (wave-16 PR-A2)", () => {
  for (const route of ROUTES) {
    it(`<${route.name}> renders exactly one h1 with id="opencoo-page-h1"`, async () => {
      const { container } = render(route.render());
      // Allow any first-paint effects to settle so a route that
      // gates the h1 behind a load doesn't fail the smoke. (None
      // currently do — but the await keeps the test resilient.)
      await waitFor(() => {
        expect(container.querySelectorAll("h1").length).toBeGreaterThan(0);
      });
      const h1s = container.querySelectorAll("h1");
      expect(h1s.length).toBe(1);
      expect(h1s[0]!.id).toBe("opencoo-page-h1");
    });
  }
});
