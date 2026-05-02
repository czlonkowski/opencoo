/**
 * asana-derive-event-type.test.ts (PR-F)
 *
 * Tests for `deriveEventType` — the helper that maps raw Asana
 * webhook event payloads to a 6-element enum or null (noise/drop).
 *
 * Five fixture payload categories:
 *   1. task created (action:added, resource_type:task)
 *   2. task completed (action:changed, change.field:completed)
 *   3. comment added (action:added, resource_type:story, parent.resource_type:task)
 *   4. assignee changed (action:changed, change.field:assignee)
 *   5. due_on changed (action:changed, change.field:due_on)
 *
 * Plus null cases:
 *   - deletions (action:deleted)
 *   - removals (action:removed)
 *   - story on non-task parent (e.g. project)
 *   - task_added_to_project (action:added, resource_type:section_task)
 *   - unknown change field (not in allowlist)
 *   - interesting fields map to 'updated'
 */
import { describe, expect, it } from "vitest";

import { deriveEventType } from "../src/derive-event-type.js";

describe("deriveEventType — created", () => {
  it("action:added + resource_type:task → 'created'", () => {
    expect(
      deriveEventType({
        action: "added",
        resource: { gid: "t1", resource_type: "task" },
      }),
    ).toBe("created");
  });
});

describe("deriveEventType — completed", () => {
  it("action:changed + change.field:completed → 'completed'", () => {
    expect(
      deriveEventType({
        action: "changed",
        resource: { gid: "t1", resource_type: "task" },
        change: { field: "completed" },
      }),
    ).toBe("completed");
  });
});

describe("deriveEventType — commented", () => {
  it("action:added + resource_type:story + parent.resource_type:task → 'commented'", () => {
    expect(
      deriveEventType({
        action: "added",
        resource: { gid: "s1", resource_type: "story" },
        parent: { gid: "t1", resource_type: "task" },
      }),
    ).toBe("commented");
  });

  it("action:added + resource_type:story + parent.resource_type:project → null (story on non-task parent)", () => {
    expect(
      deriveEventType({
        action: "added",
        resource: { gid: "s1", resource_type: "story" },
        parent: { gid: "p1", resource_type: "project" },
      }),
    ).toBeNull();
  });

  it("action:added + resource_type:story + no parent → null", () => {
    expect(
      deriveEventType({
        action: "added",
        resource: { gid: "s1", resource_type: "story" },
      }),
    ).toBeNull();
  });
});

describe("deriveEventType — assignee_changed", () => {
  it("action:changed + change.field:assignee → 'assignee_changed'", () => {
    expect(
      deriveEventType({
        action: "changed",
        resource: { gid: "t1", resource_type: "task" },
        change: { field: "assignee" },
      }),
    ).toBe("assignee_changed");
  });
});

describe("deriveEventType — due_date_changed", () => {
  it("action:changed + change.field:due_on → 'due_date_changed'", () => {
    expect(
      deriveEventType({
        action: "changed",
        resource: { gid: "t1", resource_type: "task" },
        change: { field: "due_on" },
      }),
    ).toBe("due_date_changed");
  });
});

describe("deriveEventType — updated (interesting fields allowlist)", () => {
  it.each(["name", "notes", "memberships"])(
    "change.field:%s → 'updated'",
    (field) => {
      expect(
        deriveEventType({
          action: "changed",
          resource: { gid: "t1", resource_type: "task" },
          change: { field },
        }),
      ).toBe("updated");
    },
  );
});

describe("deriveEventType — null (noise/drop)", () => {
  it("action:deleted → null", () => {
    expect(
      deriveEventType({
        action: "deleted",
        resource: { gid: "t1", resource_type: "task" },
      }),
    ).toBeNull();
  });

  it("action:removed → null", () => {
    expect(
      deriveEventType({
        action: "removed",
        resource: { gid: "t1", resource_type: "task" },
      }),
    ).toBeNull();
  });

  it("action:changed + uninteresting change.field → null", () => {
    expect(
      deriveEventType({
        action: "changed",
        resource: { gid: "t1", resource_type: "task" },
        change: { field: "some_unknown_field" },
      }),
    ).toBeNull();
  });

  it("no action → null", () => {
    expect(
      deriveEventType({
        resource: { gid: "t1", resource_type: "task" },
      }),
    ).toBeNull();
  });
});
