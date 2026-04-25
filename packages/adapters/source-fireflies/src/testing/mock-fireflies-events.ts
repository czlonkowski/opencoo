/**
 * Mock Fireflies webhook event for use-case tests (PR 27 /
 * plan #126). Builds a realistic single-event webhook body +
 * a valid HMAC-SHA256 signature against a test secret.
 *
 * The fixture also exposes the canonical `headers` bag the
 * receiver would see in production — it includes the
 * `X-Fireflies-Signature` header so the contract suite's
 * `extractSignature(headers)` test asserts the lookup.
 *
 * Decision 5: single-event-per-request envelope. The fixture
 * builds one event per call; multi-event fixtures don't exist
 * because the wire format is single-event.
 */
import { createHmac } from "node:crypto";

import { FIREFLIES_SIGNATURE_HEADER } from "../adapter.js";

export interface MockFirefliesFixtureOpts {
  readonly meetingId?: string;
  readonly transcriptId?: string;
  /** Pass `undefined` to omit `revision` from the body —
   *  exercises the eventId-fallback path (decision 4). */
  readonly revision?: string | undefined;
  readonly action?: string;
  readonly title?: string;
  readonly transcript?: string;
  readonly secret?: Buffer;
}

export interface MockFirefliesWebhookFixture {
  readonly body: Buffer;
  readonly secret: Buffer;
  readonly validSignature: string;
  readonly headers: Readonly<Record<string, string>>;
}

const DEFAULTS = {
  meetingId: "meeting-123",
  transcriptId: "transcript-123-1",
  revision: "rev-1" as string | undefined,
  action: "Transcription Completed",
  title: "Daily Standup",
  transcript:
    "Alice 00:00:01: Hello team.\nBob 00:00:08: Morning all.\nAlice 00:00:15: Quick updates today.",
} as const;

export function buildMockFirefliesWebhookFixture(
  opts: MockFirefliesFixtureOpts = {},
): MockFirefliesWebhookFixture {
  const meetingId = opts.meetingId ?? DEFAULTS.meetingId;
  const transcriptId = opts.transcriptId ?? DEFAULTS.transcriptId;
  // Distinguish "explicitly passed `undefined`" (revision-fallback
  // test) from "not passed" (use the default) — the test author
  // signals "omit revision" by passing `revision: undefined`.
  const revision =
    "revision" in opts ? opts.revision : DEFAULTS.revision;
  const action = opts.action ?? DEFAULTS.action;
  const title = opts.title ?? DEFAULTS.title;
  const transcript = opts.transcript ?? DEFAULTS.transcript;
  const secret = opts.secret ?? Buffer.from("fireflies-test-secret");

  const payload: Record<string, unknown> = {
    meetingId,
    transcriptId,
    action,
    title,
    transcript,
    completedAt: "2026-04-25T12:00:00.000Z",
  };
  if (revision !== undefined) payload["revision"] = revision;

  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const validSignature = createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [FIREFLIES_SIGNATURE_HEADER]: validSignature,
  };
  return { body, secret, validSignature, headers };
}
