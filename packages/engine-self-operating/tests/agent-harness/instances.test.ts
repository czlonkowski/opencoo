/**
 * Instance loaders. The harness resolves an agent_instances row
 * by id (primary path) or by definition_slug+name (used at boot
 * by the harness when wiring schedules to instances).
 */
import { describe, expect, it } from "vitest";

import {
  AgentInstanceNotFoundError,
  loadInstanceById,
  loadInstanceBySlugAndName,
} from "../../src/agent-harness/index.js";

import { freshAgentDb, seedAgentInstance } from "./_pglite-fixture.js";

describe("loadInstanceById — happy path", () => {
  it("returns the instance row with the seeded fields", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "heartbeat",
      instanceName: "exec-team",
      memory: { type: "run-history", count: 7 },
    });
    const instance = await loadInstanceById(
      fixture.db as unknown as Parameters<typeof loadInstanceById>[0],
      instanceId,
    );
    expect(instance.id).toBe(instanceId);
    expect(instance.definitionSlug).toBe("heartbeat");
    expect(instance.name).toBe("exec-team");
    expect(instance.scopeDomainIds).toEqual([fixture.domainId]);
    expect(instance.memory).toEqual({ type: "run-history", count: 7 });
    expect(instance.locale).toBe("en");
    expect(instance.enabled).toBe(true);
  });
});

describe("loadInstanceById — failure modes", () => {
  it("throws AgentInstanceNotFoundError for an unknown id", async () => {
    const fixture = await freshAgentDb();
    await expect(
      loadInstanceById(
        fixture.db as unknown as Parameters<typeof loadInstanceById>[0],
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toBeInstanceOf(AgentInstanceNotFoundError);
  });

  it("throws AgentInstanceNotFoundError for a disabled instance", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture);
    await fixture.raw.query(
      `UPDATE agent_instances SET enabled = false WHERE id = $1`,
      [instanceId],
    );
    await expect(
      loadInstanceById(
        fixture.db as unknown as Parameters<typeof loadInstanceById>[0],
        instanceId,
      ),
    ).rejects.toBeInstanceOf(AgentInstanceNotFoundError);
  });
});

describe("loadInstanceBySlugAndName", () => {
  it("returns the instance row when a (slug, name) pair exists", async () => {
    const fixture = await freshAgentDb();
    await seedAgentInstance(fixture, {
      definitionSlug: "lint",
      instanceName: "weekly",
    });
    const instance = await loadInstanceBySlugAndName(
      fixture.db as unknown as Parameters<typeof loadInstanceBySlugAndName>[0],
      "lint",
      "weekly",
    );
    expect(instance).not.toBeNull();
    expect(instance?.definitionSlug).toBe("lint");
    expect(instance?.name).toBe("weekly");
  });

  it("returns null for an unknown (slug, name) pair", async () => {
    const fixture = await freshAgentDb();
    const instance = await loadInstanceBySlugAndName(
      fixture.db as unknown as Parameters<typeof loadInstanceBySlugAndName>[0],
      "nope",
      "missing",
    );
    expect(instance).toBeNull();
  });
});
