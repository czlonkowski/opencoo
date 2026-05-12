/**
 * Worldview trigger pipeline tests — PR-W1 (phase-a appendix #13).
 *
 * Drives `runWorldviewTrigger` against:
 *
 *   - high impact → enqueues after 15-minute debounce window.
 *   - multiple highs collapse to ONE recompile.
 *   - medium impact → 3-or-24h threshold (count OR age).
 *   - low impact alone → never triggers.
 *   - per-domain state isolation (one domain firing doesn't move
 *     another's pending counters).
 *   - recompile-trailer commits (i.e. our own writes) are ignored.
 *   - lastSeenSha cursor moves forward; subsequent ticks only
 *     classify new commits.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  TRIGGER_HIGH_DEBOUNCE_MS,
  TRIGGER_MEDIUM_COUNT_THRESHOLD,
  TRIGGER_MEDIUM_MAX_AGE_MS,
  WORLDVIEW_COMPILE_JOB_NAME,
  WORLDVIEW_COMPILE_QUEUE_SLUG,
  freshDomainTriggerState,
  mintTriggerJobId,
  parseWorldviewImpactLines,
  runWorldviewTrigger,
  type DomainCommitsReader,
  type DomainTriggerState,
  type TriggerCommit,
  type TriggerDomain,
  type WorldviewCompileQueue,
} from "../../../src/pipelines/worldview/trigger.js";
import type { WorldviewCompileJob } from "../../../src/workers/worldview-compiler-worker.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function makeQueueMock(): {
  readonly queue: WorldviewCompileQueue;
  readonly calls: Array<{ name: string; data: WorldviewCompileJob; opts: unknown }>;
} {
  const calls: Array<{ name: string; data: WorldviewCompileJob; opts: unknown }> =
    [];
  return {
    calls,
    queue: {
      add: async (name, data, opts) => {
        calls.push({ name, data, opts });
        return { id: `job-${calls.length}` };
      },
    },
  };
}

function commit(
  sha: string,
  message: string,
  authoredAt: string | Date,
): TriggerCommit {
  return {
    sha,
    message,
    authoredAt:
      authoredAt instanceof Date ? authoredAt.toISOString() : authoredAt,
  };
}

function makeReader(
  byDomain: Record<string, ReadonlyArray<TriggerCommit>>,
): DomainCommitsReader {
  return async ({ domainSlug }) => byDomain[domainSlug] ?? [];
}

const D_A: TriggerDomain = { domainId: "id-a", domainSlug: "wiki-a" };
const D_B: TriggerDomain = { domainId: "id-b", domainSlug: "wiki-b" };

describe("parseWorldviewImpactLines", () => {
  it("returns high/medium/low for each trailer; ignores other lines", () => {
    const msg = [
      "[compiler] some commit",
      "",
      "body",
      "",
      "Worldview-Impact: high",
      "Worldview-Impact: medium",
      "Worldview-Impact: low",
      "Worldview-Impact: bogus", // unknown — skipped
      "Opencoo-Instance: x",
    ].join("\n");
    expect(parseWorldviewImpactLines(msg)).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });
  it("returns [] for empty / unrelated message", () => {
    expect(parseWorldviewImpactLines("just a subject line")).toEqual([]);
  });
});

describe("runWorldviewTrigger — high-impact debounce", () => {
  it("does NOT enqueue when the high commit is younger than 15 min", async () => {
    const now = new Date("2026-05-11T12:00:00Z");
    const high = commit(
      "sha-high",
      "[compiler] x\n\nWorldview-Impact: high",
      new Date(now.getTime() - 5 * 60 * 1000),
    );
    const state = new Map<string, DomainTriggerState>();
    const m = makeQueueMock();
    const res = await runWorldviewTrigger({
      domains: [D_A],
      readCommits: makeReader({ "wiki-a": [high] }),
      queue: m.queue,
      stateByDomain: state,
      logger: silentLogger(),
      now: () => now,
    });
    expect(res.enqueued).toHaveLength(0);
    expect(state.get(D_A.domainId)?.pendingHighWindowStartedAt).not.toBe(
      null,
    );
  });

  it("enqueues trailer-high after the 15-min window has passed", async () => {
    const high = commit(
      "sha-high",
      "[compiler] x\n\nWorldview-Impact: high",
      new Date("2026-05-11T11:00:00Z"),
    );
    const now = new Date("2026-05-11T12:00:00Z");
    const state = new Map<string, DomainTriggerState>();
    const m = makeQueueMock();
    const res = await runWorldviewTrigger({
      domains: [D_A],
      readCommits: makeReader({ "wiki-a": [high] }),
      queue: m.queue,
      stateByDomain: state,
      logger: silentLogger(),
      now: () => now,
    });
    expect(res.enqueued).toHaveLength(1);
    expect(res.enqueued[0]?.triggerType).toBe("trailer-high");
    expect(m.calls[0]?.name).toBe(WORLDVIEW_COMPILE_JOB_NAME);
    expect((m.calls[0]?.data as WorldviewCompileJob).domainSlug).toBe(
      "wiki-a",
    );
    // State reset after enqueue.
    expect(state.get(D_A.domainId)?.pendingHighWindowStartedAt).toBe(null);
    expect(state.get(D_A.domainId)?.lastRecompileAt).toEqual(now);
  });

  it("multiple highs in the window collapse to a single recompile", async () => {
    const oldest = new Date("2026-05-11T11:00:00Z");
    const newer = new Date("2026-05-11T11:30:00Z");
    const commits = [
      commit("sha-1", "[compiler] x\n\nWorldview-Impact: high", oldest),
      commit("sha-2", "[compiler] y\n\nWorldview-Impact: high", newer),
    ];
    const now = new Date("2026-05-11T12:00:00Z");
    const state = new Map<string, DomainTriggerState>();
    const m = makeQueueMock();
    const res = await runWorldviewTrigger({
      domains: [D_A],
      // listRecentCommits returns newest-first; pipeline reverses to
      // chronological internally.
      readCommits: makeReader({ "wiki-a": [...commits].reverse() }),
      queue: m.queue,
      stateByDomain: state,
      logger: silentLogger(),
      now: () => now,
    });
    expect(res.enqueued).toHaveLength(1);
    expect(m.calls).toHaveLength(1);
  });
});

describe("runWorldviewTrigger — medium thresholds", () => {
  it("enqueues trailer-medium when 3 mediums accumulate", async () => {
    const t = new Date("2026-05-11T11:00:00Z");
    const commits = [
      commit("sha-1", "Worldview-Impact: medium", t),
      commit("sha-2", "Worldview-Impact: medium", t),
      commit("sha-3", "Worldview-Impact: medium", t),
    ];
    const now = new Date("2026-05-11T11:01:00Z");
    const state = new Map<string, DomainTriggerState>();
    const m = makeQueueMock();
    const res = await runWorldviewTrigger({
      domains: [D_A],
      readCommits: makeReader({ "wiki-a": [...commits].reverse() }),
      queue: m.queue,
      stateByDomain: state,
      logger: silentLogger(),
      now: () => now,
    });
    expect(res.enqueued).toHaveLength(1);
    expect(res.enqueued[0]?.triggerType).toBe("trailer-medium");
    expect(state.get(D_A.domainId)?.pendingMediumCount).toBe(0);
    expect(TRIGGER_MEDIUM_COUNT_THRESHOLD).toBe(3);
  });

  it("does NOT enqueue with 2 mediums alone (under threshold)", async () => {
    const t = new Date("2026-05-11T11:00:00Z");
    const commits = [
      commit("sha-1", "Worldview-Impact: medium", t),
      commit("sha-2", "Worldview-Impact: medium", t),
    ];
    const now = new Date("2026-05-11T11:30:00Z");
    const state = new Map<string, DomainTriggerState>();
    const m = makeQueueMock();
    const res = await runWorldviewTrigger({
      domains: [D_A],
      readCommits: makeReader({ "wiki-a": [...commits].reverse() }),
      queue: m.queue,
      stateByDomain: state,
      logger: silentLogger(),
      now: () => now,
    });
    expect(res.enqueued).toHaveLength(0);
    expect(state.get(D_A.domainId)?.pendingMediumCount).toBe(2);
  });

  it("enqueues trailer-medium when the oldest pending medium is >=24h old", async () => {
    // First tick: one medium lands, state advances.
    const m1 = commit(
      "sha-1",
      "Worldview-Impact: medium",
      new Date("2026-05-10T08:00:00Z"),
    );
    const state = new Map<string, DomainTriggerState>();
    const m = makeQueueMock();
    await runWorldviewTrigger({
      domains: [D_A],
      readCommits: makeReader({ "wiki-a": [m1] }),
      queue: m.queue,
      stateByDomain: state,
      logger: silentLogger(),
      now: () => new Date("2026-05-10T08:05:00Z"),
    });
    expect(m.calls).toHaveLength(0);

    // Second tick 25h later — same medium still pending, age gate fires.
    const later = new Date("2026-05-11T09:00:00Z");
    expect(
      later.getTime() -
        state.get(D_A.domainId)!.pendingMediumFirstAt!.getTime(),
    ).toBeGreaterThanOrEqual(TRIGGER_MEDIUM_MAX_AGE_MS);
    const res = await runWorldviewTrigger({
      domains: [D_A],
      // Same commit again — pipeline sees lastSeenSha and dedupes
      // (no double-count).
      readCommits: makeReader({ "wiki-a": [m1] }),
      queue: m.queue,
      stateByDomain: state,
      logger: silentLogger(),
      now: () => later,
    });
    expect(res.enqueued).toHaveLength(1);
    expect(res.enqueued[0]?.triggerType).toBe("trailer-medium");
  });
});

describe("runWorldviewTrigger — low impact never triggers alone", () => {
  it("low-only commits never enqueue a recompile", async () => {
    const lows = Array.from({ length: 10 }, (_, i) =>
      commit(
        `sha-l${i}`,
        "Worldview-Impact: low",
        new Date("2026-05-10T08:00:00Z"),
      ),
    );
    const now = new Date("2026-05-12T00:00:00Z"); // 48h+ later
    const state = new Map<string, DomainTriggerState>();
    const m = makeQueueMock();
    const res = await runWorldviewTrigger({
      domains: [D_A],
      readCommits: makeReader({ "wiki-a": [...lows].reverse() }),
      queue: m.queue,
      stateByDomain: state,
      logger: silentLogger(),
      now: () => now,
    });
    expect(res.enqueued).toHaveLength(0);
    expect(state.get(D_A.domainId)?.pendingMediumCount).toBe(0);
    expect(state.get(D_A.domainId)?.pendingHighWindowStartedAt).toBe(null);
  });
});

describe("runWorldviewTrigger — per-domain state isolation", () => {
  it("domain A firing does not move domain B's pending counters", async () => {
    const t = new Date("2026-05-11T11:00:00Z");
    const aCommits = [
      commit("sha-a1", "Worldview-Impact: high", t),
      commit("sha-a2", "Worldview-Impact: high", t),
    ];
    const bCommits = [commit("sha-b1", "Worldview-Impact: medium", t)];
    const now = new Date("2026-05-11T12:00:00Z");
    const state = new Map<string, DomainTriggerState>();
    const m = makeQueueMock();
    const res = await runWorldviewTrigger({
      domains: [D_A, D_B],
      readCommits: makeReader({
        "wiki-a": [...aCommits].reverse(),
        "wiki-b": [...bCommits].reverse(),
      }),
      queue: m.queue,
      stateByDomain: state,
      logger: silentLogger(),
      now: () => now,
    });
    expect(res.enqueued.map((e) => e.domainSlug)).toEqual(["wiki-a"]);
    expect(state.get(D_B.domainId)?.pendingMediumCount).toBe(1);
    expect(state.get(D_B.domainId)?.lastRecompileAt).toBe(null);
    expect(TRIGGER_HIGH_DEBOUNCE_MS).toBe(15 * 60 * 1000);
  });
});

describe("runWorldviewTrigger — recompile commits are ignored", () => {
  it("commits bearing Worldview-Recompile trailer do NOT count as triggers", async () => {
    // The worker's own commit has BOTH a Worldview-Recompile trailer
    // AND an arbitrary `Worldview-Impact: high` body — we still must
    // skip it (otherwise a recompile triggers another recompile and
    // we loop).
    const own = commit(
      "sha-self",
      [
        "[worldview] worldview-compile: trailer-high",
        "",
        "Worldview-Impact: high",
        "Worldview-Recompile: trailer-high",
        "Opencoo-Instance: test",
      ].join("\n"),
      new Date("2026-05-11T11:00:00Z"),
    );
    const now = new Date("2026-05-11T12:00:00Z");
    const state = new Map<string, DomainTriggerState>();
    const m = makeQueueMock();
    const res = await runWorldviewTrigger({
      domains: [D_A],
      readCommits: makeReader({ "wiki-a": [own] }),
      queue: m.queue,
      stateByDomain: state,
      logger: silentLogger(),
      now: () => now,
    });
    expect(res.enqueued).toHaveLength(0);
    // The cursor still advances so we don't re-evaluate it next tick.
    expect(state.get(D_A.domainId)?.lastSeenSha).toBe("sha-self");
  });
});

describe("runWorldviewTrigger — cursor advances", () => {
  it("only NEW commits since lastSeenSha get classified on the second tick", async () => {
    const t = new Date("2026-05-11T11:00:00Z");
    const m = makeQueueMock();
    const state = new Map<string, DomainTriggerState>();

    // Tick 1 — one high commit, under debounce so no enqueue.
    const c1 = commit("sha-1", "Worldview-Impact: high", t);
    await runWorldviewTrigger({
      domains: [D_A],
      readCommits: makeReader({ "wiki-a": [c1] }),
      queue: m.queue,
      stateByDomain: state,
      logger: silentLogger(),
      now: () => new Date(t.getTime() + 60_000),
    });
    expect(state.get(D_A.domainId)?.lastSeenSha).toBe("sha-1");

    // Tick 2 — a second high commit arrives. Cursor sees only
    // sha-2 as new; the first high is still tracked via
    // pendingHighWindowStartedAt. After 15 min from THE FIRST high
    // (sha-1's timestamp), the recompile fires.
    const c2 = commit(
      "sha-2",
      "Worldview-Impact: high",
      new Date(t.getTime() + 5 * 60_000),
    );
    const later = new Date(t.getTime() + 16 * 60_000); // 16 min after sha-1
    const res = await runWorldviewTrigger({
      domains: [D_A],
      readCommits: makeReader({ "wiki-a": [c2, c1] }), // newest first
      queue: m.queue,
      stateByDomain: state,
      logger: silentLogger(),
      now: () => later,
    });
    expect(res.enqueued).toHaveLength(1);
    expect(m.calls).toHaveLength(1);
  });
});

describe("mintTriggerJobId", () => {
  it("yields a stable, collision-resistant shape", () => {
    const id = mintTriggerJobId({
      domainId: "abc",
      triggerType: "trailer-high",
      now: new Date(1717000000000),
    });
    expect(id).toBe("worldview-trailer-high-abc-1717000000000");
  });
});

describe("queue+job constants", () => {
  it("queue slug + job name pinned for cross-package agreement", () => {
    expect(WORLDVIEW_COMPILE_QUEUE_SLUG).toBe("selfop.worldview.compile");
    expect(WORLDVIEW_COMPILE_JOB_NAME).toBe("worldview.compile");
  });
});

// Silence unused-import lint.
void freshDomainTriggerState;
