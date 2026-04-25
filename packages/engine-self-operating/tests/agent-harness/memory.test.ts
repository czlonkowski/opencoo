/**
 * Instance memory loaders. v0.1 ships:
 *   - 'none' → []
 *   - 'log-tail' → [] (reserved for v0.2)
 *   - 'run-history' → last N terminal rows for the same
 *      instance_id (instance-scope per THREAT-MODEL §3.5)
 *
 * The harness ALWAYS spotlights() loaded entries before
 * injecting them into a prompt; this loader just returns raw
 * rows.
 */
import { describe, expect, it } from "vitest";

import { loadInstanceMemory } from "../../src/agent-harness/index.js";

import { freshAgentDb, seedAgentInstance } from "./_pglite-fixture.js";

async function seedRun(
  fixture: Awaited<ReturnType<typeof freshAgentDb>>,
  instanceId: string,
  definitionSlug: string,
  status: "success" | "failed" | "timeout",
  output: unknown,
  startedAtSecondsAgo: number,
): Promise<void> {
  await fixture.raw.query(
    `INSERT INTO agent_runs
       (definition_slug, instance_id, trigger, status, output, started_at, ended_at, created_at)
     VALUES ($1, $2::uuid, 'scheduled', $3::agent_run_status, $4::jsonb,
             NOW() - ($5::text || ' seconds')::interval,
             NOW() - ($5::text || ' seconds')::interval,
             NOW() - ($5::text || ' seconds')::interval)`,
    [
      definitionSlug,
      instanceId,
      status,
      JSON.stringify(output),
      String(startedAtSecondsAgo),
    ],
  );
}

describe("loadInstanceMemory — type='none'", () => {
  it("returns an empty array", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture);
    const memory = await loadInstanceMemory(
      fixture.db as unknown as Parameters<typeof loadInstanceMemory>[0],
      instanceId,
      { type: "none" },
    );
    expect(memory).toEqual([]);
  });
});

describe("loadInstanceMemory — type='log-tail' (reserved for v0.2)", () => {
  it("returns an empty array — v0.1 doesn't implement this loader", async () => {
    const fixture = await freshAgentDb();
    const { instanceId, definitionSlug } = await seedAgentInstance(fixture);
    await seedRun(fixture, instanceId, definitionSlug, "success", { x: 1 }, 10);
    const memory = await loadInstanceMemory(
      fixture.db as unknown as Parameters<typeof loadInstanceMemory>[0],
      instanceId,
      { type: "log-tail", count: 5 },
    );
    expect(memory).toEqual([]);
  });
});

describe("loadInstanceMemory — type='run-history'", () => {
  it("returns the last N terminal rows newest-first", async () => {
    const fixture = await freshAgentDb();
    const { instanceId, definitionSlug } = await seedAgentInstance(fixture);
    await seedRun(fixture, instanceId, definitionSlug, "success", { run: 1 }, 30);
    await seedRun(fixture, instanceId, definitionSlug, "failed", { run: 2 }, 20);
    await seedRun(fixture, instanceId, definitionSlug, "success", { run: 3 }, 10);
    const memory = await loadInstanceMemory(
      fixture.db as unknown as Parameters<typeof loadInstanceMemory>[0],
      instanceId,
      { type: "run-history", count: 2 },
    );
    expect(memory).toHaveLength(2);
    // Newest first → run 3 then run 2.
    expect(memory[0]?.body).toContain('"run":3');
    expect(memory[1]?.body).toContain('"run":2');
  });

  it("scopes strictly to the requested instance_id (per THREAT-MODEL §3.5)", async () => {
    const fixture = await freshAgentDb();
    const { instanceId: instA, definitionSlug } = await seedAgentInstance(
      fixture,
      { instanceName: "team-a" },
    );
    const { instanceId: instB } = await seedAgentInstance(fixture, {
      definitionSlug,
      instanceName: "team-b",
    });
    await seedRun(fixture, instA, definitionSlug, "success", { from: "A" }, 10);
    await seedRun(fixture, instB, definitionSlug, "success", { from: "B" }, 5);
    const memoryA = await loadInstanceMemory(
      fixture.db as unknown as Parameters<typeof loadInstanceMemory>[0],
      instA,
      { type: "run-history", count: 5 },
    );
    expect(memoryA).toHaveLength(1);
    expect(memoryA[0]?.body).toContain('"from":"A"');
  });

  it("excludes 'running' rows (only terminal rows count as memory)", async () => {
    const fixture = await freshAgentDb();
    const { instanceId, definitionSlug } = await seedAgentInstance(fixture);
    // One terminal, one still-running.
    await seedRun(fixture, instanceId, definitionSlug, "success", { run: 1 }, 30);
    await fixture.raw.query(
      `INSERT INTO agent_runs (definition_slug, instance_id, trigger, status)
       VALUES ($1, $2::uuid, 'scheduled', 'running')`,
      [definitionSlug, instanceId],
    );
    const memory = await loadInstanceMemory(
      fixture.db as unknown as Parameters<typeof loadInstanceMemory>[0],
      instanceId,
      { type: "run-history", count: 5 },
    );
    expect(memory).toHaveLength(1);
  });

  it("respects count (defaults to 5 when omitted)", async () => {
    const fixture = await freshAgentDb();
    const { instanceId, definitionSlug } = await seedAgentInstance(fixture);
    for (let i = 0; i < 8; i++) {
      await seedRun(
        fixture,
        instanceId,
        definitionSlug,
        "success",
        { run: i },
        100 - i,
      );
    }
    const memory = await loadInstanceMemory(
      fixture.db as unknown as Parameters<typeof loadInstanceMemory>[0],
      instanceId,
      { type: "run-history" },
    );
    expect(memory).toHaveLength(5);
  });

  it("count <= 0 returns []", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture);
    const memory = await loadInstanceMemory(
      fixture.db as unknown as Parameters<typeof loadInstanceMemory>[0],
      instanceId,
      { type: "run-history", count: 0 },
    );
    expect(memory).toEqual([]);
  });
});

// Fail-closed on unknown `memory.type`. The Zod schema in
// @opencoo/shared/db rejects unknown types at the validation
// edge, but if a misshapen row ever reaches the loader (for
// example: a v0.2 type added to one engine but not the other),
// the loader must throw `TypeError` rather than silently
// returning [] and pretending the agent has no memory.
// (copilot #21)
describe("loadInstanceMemory — fail-closed on unknown type", () => {
  it("throws TypeError when memory.type is not one of the v0.1 loaders", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture);
    await expect(
      loadInstanceMemory(
        fixture.db as unknown as Parameters<typeof loadInstanceMemory>[0],
        instanceId,
        // Cast through unknown — the runtime guard is the
        // load-bearing safeguard; the type system already
        // rejects this branch.
        { type: "telemetry-stream" } as unknown as Parameters<
          typeof loadInstanceMemory
        >[2],
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
