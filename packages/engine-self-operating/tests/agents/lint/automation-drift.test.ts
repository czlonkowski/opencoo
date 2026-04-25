/**
 * `automation_drift` detector — pure function over a flat list
 * of tool-call observations + a definition→allowed-tools map.
 * Flags any observation whose `name` is NOT in the matching
 * definition's allowed set.
 *
 * Per Q6 (architecture) the orchestrator's SQL pulls
 * `agent_runs` rows from a 30-day window with status='success'
 * and unrolls `tool_calls` into one row per (definition_slug,
 * run_id, started_at, name). The detector is then a pure JS
 * filter — easy to unit-test, no DB.
 */
import { describe, expect, it } from "vitest";

import {
  detectAutomationDrift,
  type ToolCallObservation,
} from "../../../src/agents/lint/detectors/automation-drift.js";

const ALLOWED = new Map<string, ReadonlySet<string>>([
  ["heartbeat", new Set(["worldview.read", "index.search"])],
  ["lint", new Set(["worldview.read", "index.search", "wiki.read_page"])],
]);

function obs(
  definitionSlug: string,
  name: string,
  startedAt = "2026-04-25T10:00:00Z",
  runId = "00000000-0000-0000-0000-000000000001",
): ToolCallObservation {
  return { definitionSlug, runId, startedAt, name };
}

describe("detectAutomationDrift", () => {
  it("flags an observation whose name is NOT in the agent's allowed set", () => {
    const findings = detectAutomationDrift({
      observations: [obs("heartbeat", "wiki.write_page")],
      allowedToolsBySlug: ALLOWED,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("automation_drift");
    expect(findings[0]?.severity).toBe("medium");
    expect(findings[0]?.scope).toContain("heartbeat");
    expect(findings[0]?.detail).toMatchObject({
      definitionSlug: "heartbeat",
      toolName: "wiki.write_page",
    });
  });

  it("does NOT flag an observation whose name IS in the agent's allowed set", () => {
    const findings = detectAutomationDrift({
      observations: [
        obs("heartbeat", "worldview.read"),
        obs("heartbeat", "index.search"),
      ],
      allowedToolsBySlug: ALLOWED,
    });
    expect(findings).toEqual([]);
  });

  it("emits one finding per drift observation (no dedupe v0.1)", () => {
    // Two separate runs both invoking the same drift tool — we
    // surface both. Dedupe is a Review Dashboard concern.
    const findings = detectAutomationDrift({
      observations: [
        obs("heartbeat", "wiki.write_page", "2026-04-25T10:00:00Z", "run-1"),
        obs("heartbeat", "wiki.write_page", "2026-04-25T11:00:00Z", "run-2"),
      ],
      allowedToolsBySlug: ALLOWED,
    });
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((f) => f.detail?.runId))).toEqual(
      new Set(["run-1", "run-2"]),
    );
  });

  it("skips observations from agents not in the allowed-tools map (registry drift, not driftful run)", () => {
    // The orchestrator pulls observations for slugs matching
    // every registered agent. If a run's slug isn't in the map
    // (someone registered it in the past, then unregistered),
    // we cannot decide whether the call was permitted — so we
    // skip rather than false-positive. The orchestrator logs
    // these separately.
    const findings = detectAutomationDrift({
      observations: [obs("removed-agent", "anything")],
      allowedToolsBySlug: ALLOWED,
    });
    expect(findings).toEqual([]);
  });

  it("returns [] for empty observations", () => {
    expect(
      detectAutomationDrift({
        observations: [],
        allowedToolsBySlug: ALLOWED,
      }),
    ).toEqual([]);
  });

  it("scope includes the run id so the Review Dashboard can deep-link", () => {
    const findings = detectAutomationDrift({
      observations: [
        obs("heartbeat", "shell.exec", "2026-04-25T10:00:00Z", "run-x"),
      ],
      allowedToolsBySlug: ALLOWED,
    });
    expect(findings[0]?.scope).toContain("run-x");
  });

  it("partitions across multiple agents correctly", () => {
    const findings = detectAutomationDrift({
      observations: [
        obs("heartbeat", "worldview.read"), // ok
        obs("heartbeat", "wiki.write"), // drift
        obs("lint", "wiki.read_page"), // ok
        obs("lint", "shell.exec"), // drift
      ],
      allowedToolsBySlug: ALLOWED,
    });
    const driftedTools = findings.map((f) => f.detail?.toolName);
    expect(driftedTools).toEqual(["wiki.write", "shell.exec"]);
  });
});
