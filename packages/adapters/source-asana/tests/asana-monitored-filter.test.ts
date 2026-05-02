/**
 * asana-monitored-filter.test.ts (PR-F)
 *
 * Tests that events for project_gids NOT in
 * `config.monitoredProjectGids` are silently dropped — they produce
 * zero `SourceWebhookEvent`s and no ValidationError.
 *
 * When `monitoredProjectGids` is undefined (backwards-compat),
 * all events pass.
 */
import { describe, expect, it } from "vitest";

import { buildAsanaWebhookHelpers } from "../src/adapter.js";
import { buildMockAsanaWebhookFixtureWithParent } from "../src/testing/mock-asana-events.js";

describe("asana monitored-project filter", () => {
  it("event with matching project_gid → emitted (survives filter)", () => {
    const helpers = buildAsanaWebhookHelpers({
      monitoredProjectGids: ["proj-100"],
    });
    const body = buildMockAsanaWebhookFixtureWithParent({
      events: [
        {
          user_gid: "u1",
          resource_gid: "t1",
          resource_type: "task",
          action: "added",
          created_at: "2026-04-25T12:00:00Z",
          parent_gid: "proj-100",
          parent_type: "project",
        },
      ],
    }).body;

    const events = helpers.parseEvents({ body });
    expect(events).toHaveLength(1);
  });

  it("event with non-matching project_gid → silently dropped (0 events emitted)", () => {
    const helpers = buildAsanaWebhookHelpers({
      monitoredProjectGids: ["proj-100"],
    });
    const body = buildMockAsanaWebhookFixtureWithParent({
      events: [
        {
          user_gid: "u1",
          resource_gid: "t1",
          resource_type: "task",
          action: "added",
          created_at: "2026-04-25T12:00:00Z",
          parent_gid: "proj-999",
          parent_type: "project",
        },
      ],
    }).body;

    const events = helpers.parseEvents({ body });
    expect(events).toHaveLength(0);
  });

  it("no monitoredProjectGids (undefined) → all events pass (backwards-compat)", () => {
    const helpers = buildAsanaWebhookHelpers({});
    const body = buildMockAsanaWebhookFixtureWithParent({
      events: [
        {
          user_gid: "u1",
          resource_gid: "t1",
          resource_type: "task",
          action: "added",
          created_at: "2026-04-25T12:00:00Z",
          parent_gid: "any-proj",
          parent_type: "project",
        },
      ],
    }).body;

    const events = helpers.parseEvents({ body });
    expect(events).toHaveLength(1);
  });

  it("multiple events: matching ones pass, non-matching drop silently", () => {
    const helpers = buildAsanaWebhookHelpers({
      monitoredProjectGids: ["proj-100"],
    });
    const body = buildMockAsanaWebhookFixtureWithParent({
      events: [
        {
          user_gid: "u1",
          resource_gid: "t1",
          resource_type: "task",
          action: "added",
          created_at: "2026-04-25T12:00:00Z",
          parent_gid: "proj-100",
          parent_type: "project",
        },
        {
          user_gid: "u2",
          resource_gid: "t2",
          resource_type: "task",
          action: "changed",
          created_at: "2026-04-25T12:01:00Z",
          change_field: "completed",
          parent_gid: "proj-999",
          parent_type: "project",
        },
      ],
    }).body;

    const events = helpers.parseEvents({ body });
    expect(events).toHaveLength(1);
    expect(events[0]?.doc.sourceDocId).toContain("t1");
  });

  it("event with no parent → passes through if no monitoredProjectGids filter set", () => {
    const helpers = buildAsanaWebhookHelpers({});
    const body = buildMockAsanaWebhookFixtureWithParent({
      events: [
        {
          user_gid: "u1",
          resource_gid: "t1",
          resource_type: "task",
          action: "added",
          created_at: "2026-04-25T12:00:00Z",
        },
      ],
    }).body;

    const events = helpers.parseEvents({ body });
    expect(events).toHaveLength(1);
  });

  it("event with no parent, monitoredProjectGids set → dropped (no project match)", () => {
    const helpers = buildAsanaWebhookHelpers({
      monitoredProjectGids: ["proj-100"],
    });
    const body = buildMockAsanaWebhookFixtureWithParent({
      events: [
        {
          user_gid: "u1",
          resource_gid: "t1",
          resource_type: "task",
          action: "added",
          created_at: "2026-04-25T12:00:00Z",
          // no parent
        },
      ],
    }).body;

    const events = helpers.parseEvents({ body });
    expect(events).toHaveLength(0);
  });
});
