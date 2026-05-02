/**
 * Mock Asana webhook events for use-case tests (PR 24 /
 * plan #115). Builds a realistic webhook body + a valid
 * HMAC-SHA256 signature against a test secret.
 *
 * The fixture also exposes the canonical `headers` bag the
 * receiver would see in production — it includes the
 * `X-Hook-Signature` header so the contract suite's
 * `extractSignature(headers)` test asserts the lookup.
 */
import { createHmac } from "node:crypto";

import { ASANA_SIGNATURE_HEADER } from "../adapter.js";

export interface MockAsanaEvent {
  readonly user_gid: string;
  readonly resource_gid: string;
  readonly resource_type: string;
  readonly action: string;
  readonly created_at: string;
  readonly change_field?: string;
}

/** Extended event fixture that includes a `parent` field —
 *  used for monitored-project filter tests (PR-F). */
export interface MockAsanaEventWithParent extends MockAsanaEvent {
  readonly parent_gid?: string;
  readonly parent_type?: string;
}

export interface MockAsanaWebhookFixture {
  readonly body: Buffer;
  readonly secret: Buffer;
  readonly validSignature: string;
  readonly headers: Readonly<Record<string, string>>;
}

const DEFAULT_EVENT: MockAsanaEvent = {
  user_gid: "user-1",
  resource_gid: "task-42",
  resource_type: "task",
  action: "added",
  created_at: "2026-04-25T12:00:00.000Z",
  change_field: "name",
};

export function buildMockAsanaWebhookFixture(args?: {
  readonly events?: ReadonlyArray<MockAsanaEvent>;
  readonly secret?: Buffer;
}): MockAsanaWebhookFixture {
  const events = args?.events ?? [DEFAULT_EVENT];
  const secret = args?.secret ?? Buffer.from("asana-test-secret");
  const body = Buffer.from(
    JSON.stringify({
      events: events.map((ev) => ({
        user: { gid: ev.user_gid },
        resource: {
          gid: ev.resource_gid,
          resource_type: ev.resource_type,
        },
        action: ev.action,
        created_at: ev.created_at,
        change: ev.change_field ? { field: ev.change_field } : undefined,
      })),
    }),
    "utf8",
  );
  const validSignature = createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [ASANA_SIGNATURE_HEADER]: validSignature,
  };
  return { body, secret, validSignature, headers };
}

/**
 * Builds a fixture with `parent` field on events — needed for
 * monitored-project filter tests (PR-F). Like `buildMockAsanaWebhookFixture`,
 * the body IS signed (HMAC-SHA256 against the test secret). Filter tests
 * call `parseEvents` directly and skip the verifier, so the signature is
 * present but not checked in those tests.
 */
export function buildMockAsanaWebhookFixtureWithParent(args?: {
  readonly events?: ReadonlyArray<MockAsanaEventWithParent>;
  readonly secret?: Buffer;
}): MockAsanaWebhookFixture {
  const events = args?.events ?? [
    {
      user_gid: "user-1",
      resource_gid: "task-42",
      resource_type: "task",
      action: "added",
      created_at: "2026-04-25T12:00:00.000Z",
    },
  ];
  const secret = args?.secret ?? Buffer.from("asana-test-secret");
  const body = Buffer.from(
    JSON.stringify({
      events: events.map((ev) => ({
        user: { gid: ev.user_gid },
        resource: {
          gid: ev.resource_gid,
          resource_type: ev.resource_type,
        },
        action: ev.action,
        created_at: ev.created_at,
        change: ev.change_field ? { field: ev.change_field } : undefined,
        parent:
          ev.parent_gid !== undefined
            ? { gid: ev.parent_gid, resource_type: ev.parent_type ?? "project" }
            : undefined,
      })),
    }),
    "utf8",
  );
  const validSignature = createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [ASANA_SIGNATURE_HEADER]: validSignature,
  };
  return { body, secret, validSignature, headers };
}
