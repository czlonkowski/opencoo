/**
 * deriveEventType — maps a raw Asana webhook event to a semantic
 * EventType enum value, or null when the event is noise/should
 * be dropped.
 *
 * Rules (from PR-F spec and PoC reference):
 *   created           action:added + resource_type:task
 *   completed         action:changed + change.field:completed
 *   commented         action:added + resource_type:story + parent.resource_type:task
 *   assignee_changed  action:changed + change.field:assignee
 *   due_date_changed  action:changed + change.field:due_on
 *   updated           action:changed + change.field ∈ {name, notes, memberships}
 *   null              everything else (deletions, removals,
 *                     story-on-non-task-parent, uninteresting fields)
 *
 * DONE_WITH_CONCERNS: the `updated` allowlist is intentionally
 * conservative ({name, notes, memberships}). Fields like `tags`,
 * `followers`, `projects`, `custom_fields` are NOT emitted as
 * `updated`. If a partner needs those, extend the allowlist here
 * and add test cases.
 */

export type EventType =
  | "created"
  | "completed"
  | "commented"
  | "assignee_changed"
  | "due_date_changed"
  | "updated";

/**
 * Partial shape of the raw Asana event that deriveEventType
 * inspects. Caller is responsible for ensuring the full shape
 * (resource.gid, resource.resource_type, action) are valid before
 * calling — deriveEventType operates on the semantic layer, not
 * on basic required-field validation.
 */
export interface PartialAsanaEvent {
  readonly action?: string;
  readonly resource?: {
    readonly gid?: string;
    readonly resource_type?: string;
  };
  readonly parent?: {
    readonly gid?: string;
    readonly resource_type?: string;
  };
  readonly change?: {
    readonly field?: string;
  };
}

/** Fields that map to the 'updated' event type. */
const UPDATED_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  "name",
  "notes",
  "memberships",
]);

export function deriveEventType(event: PartialAsanaEvent): EventType | null {
  const action = event.action;
  const resourceType = event.resource?.resource_type;
  const changeField = event.change?.field;
  const parentType = event.parent?.resource_type;

  if (!action) return null;

  if (action === "added") {
    if (resourceType === "task") return "created";
    if (resourceType === "story") {
      // Commented = story whose parent is a task.
      // Story on any other parent type (project, etc.) is noise.
      if (parentType === "task") return "commented";
      return null;
    }
    return null;
  }

  if (action === "changed") {
    if (changeField === "completed") return "completed";
    if (changeField === "assignee") return "assignee_changed";
    if (changeField === "due_on") return "due_date_changed";
    if (changeField !== undefined && UPDATED_FIELD_ALLOWLIST.has(changeField)) {
      return "updated";
    }
    return null;
  }

  // action:deleted, action:removed, and anything else → null.
  return null;
}
