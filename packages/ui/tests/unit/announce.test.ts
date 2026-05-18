/**
 * `pushAnnouncement` / live-region queue tests — PR-A4 (wave-16,
 * phase-a appendix #16).
 *
 * Pins:
 *   - `pushAnnouncement(text)` notifies polite subscribers by
 *     default; `tone: 'assertive'` notifies assertive subscribers.
 *   - Messages auto-remove after `timeoutMs` (default 8000ms).
 *   - Subscribers can register/unregister and only see
 *     subsequently-pushed messages — the queue does NOT replay
 *     history to late joiners (so the SR-only live regions are
 *     idempotent across remounts and don't blurt stale text).
 *   - Two independent channels (polite vs assertive) so an error
 *     can never demote to polite under a polite-only subscriber.
 *   - Pushing the same text twice in a row still notifies — the
 *     id makes each push observable even when the payload string
 *     is identical (assistive tech often re-reads on aria-atomic
 *     turnover).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetAnnouncementsForTests,
  pushAnnouncement,
  subscribeToAnnouncements,
  type AnnouncementTone,
  type LiveAnnouncement,
} from "../../src/lib/announce.js";

interface Captured {
  readonly tone: AnnouncementTone;
  readonly messages: readonly LiveAnnouncement[];
}

function capture(tone: AnnouncementTone): {
  readonly snapshots: Captured[];
  readonly unsubscribe: () => void;
} {
  const snapshots: Captured[] = [];
  const unsubscribe = subscribeToAnnouncements(tone, (messages) => {
    snapshots.push({ tone, messages });
  });
  return { snapshots, unsubscribe };
}

describe("pushAnnouncement — tone routing", () => {
  beforeEach(() => {
    __resetAnnouncementsForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetAnnouncementsForTests();
  });

  it("default tone is polite", () => {
    const polite = capture("polite");
    const assertive = capture("assertive");
    pushAnnouncement("saved");
    expect(polite.snapshots.at(-1)?.messages.map((m) => m.text)).toEqual([
      "saved",
    ]);
    expect(assertive.snapshots.at(-1)?.messages ?? []).toEqual([]);
    polite.unsubscribe();
    assertive.unsubscribe();
  });

  it("tone: 'assertive' routes to assertive subscribers, not polite", () => {
    const polite = capture("polite");
    const assertive = capture("assertive");
    pushAnnouncement("boom", { tone: "assertive" });
    expect(assertive.snapshots.at(-1)?.messages.map((m) => m.text)).toEqual([
      "boom",
    ]);
    expect(polite.snapshots.at(-1)?.messages ?? []).toEqual([]);
    polite.unsubscribe();
    assertive.unsubscribe();
  });

  it("explicit tone: 'polite' routes to polite subscribers", () => {
    const polite = capture("polite");
    pushAnnouncement("hi", { tone: "polite" });
    expect(polite.snapshots.at(-1)?.messages.map((m) => m.text)).toEqual([
      "hi",
    ]);
    polite.unsubscribe();
  });
});

describe("pushAnnouncement — auto-remove", () => {
  beforeEach(() => {
    __resetAnnouncementsForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetAnnouncementsForTests();
  });

  it("auto-removes after the default 8000ms", () => {
    const polite = capture("polite");
    pushAnnouncement("saved");
    expect(polite.snapshots.at(-1)?.messages).toHaveLength(1);
    vi.advanceTimersByTime(7999);
    expect(polite.snapshots.at(-1)?.messages).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(polite.snapshots.at(-1)?.messages).toHaveLength(0);
    polite.unsubscribe();
  });

  it("honours a custom timeoutMs", () => {
    const polite = capture("polite");
    pushAnnouncement("saved", { timeoutMs: 1500 });
    vi.advanceTimersByTime(1499);
    expect(polite.snapshots.at(-1)?.messages).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(polite.snapshots.at(-1)?.messages).toHaveLength(0);
    polite.unsubscribe();
  });

  it("multiple pushes accumulate then drain in FIFO order", () => {
    const polite = capture("polite");
    pushAnnouncement("first", { timeoutMs: 1000 });
    pushAnnouncement("second", { timeoutMs: 2000 });
    expect(polite.snapshots.at(-1)?.messages.map((m) => m.text)).toEqual([
      "first",
      "second",
    ]);
    vi.advanceTimersByTime(1001);
    expect(polite.snapshots.at(-1)?.messages.map((m) => m.text)).toEqual([
      "second",
    ]);
    vi.advanceTimersByTime(1000);
    expect(polite.snapshots.at(-1)?.messages).toHaveLength(0);
    polite.unsubscribe();
  });
});

describe("pushAnnouncement — subscribers", () => {
  beforeEach(() => {
    __resetAnnouncementsForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetAnnouncementsForTests();
  });

  it("a subscriber added after a push does NOT replay the pending message", () => {
    pushAnnouncement("first");
    // Snapshot reflects state at subscribe time; with no replay,
    // the late joiner sees the current queue but is not retro-
    // actively notified for the prior push. We pin this by
    // asserting that the new subscriber's initial snapshot is
    // empty — the push fired before subscribe and the queue's
    // current contents would only flow to the subscriber if a
    // SUBSEQUENT push happens.
    const late = capture("polite");
    // The subscribe handler is not invoked synchronously on
    // subscribe — only on the next push.
    expect(late.snapshots).toEqual([]);
    pushAnnouncement("second");
    // Now the subscriber is notified — its snapshot includes
    // BOTH messages (the queue is shared state; subscribe doesn't
    // wipe history, it just doesn't replay to a fresh listener).
    expect(late.snapshots.at(-1)?.messages.map((m) => m.text)).toEqual([
      "first",
      "second",
    ]);
    late.unsubscribe();
  });

  it("unsubscribe stops further notifications", () => {
    const polite = capture("polite");
    pushAnnouncement("first");
    polite.unsubscribe();
    pushAnnouncement("second");
    // Last snapshot is from before the unsubscribe.
    expect(polite.snapshots.at(-1)?.messages.map((m) => m.text)).toEqual([
      "first",
    ]);
  });

  it("multiple subscribers on the same tone all receive notifications", () => {
    const a = capture("polite");
    const b = capture("polite");
    pushAnnouncement("hello");
    expect(a.snapshots.at(-1)?.messages.map((m) => m.text)).toEqual(["hello"]);
    expect(b.snapshots.at(-1)?.messages.map((m) => m.text)).toEqual(["hello"]);
    a.unsubscribe();
    b.unsubscribe();
  });

  it("each push carries a unique id even when the text repeats", () => {
    const polite = capture("polite");
    pushAnnouncement("same");
    pushAnnouncement("same");
    const last = polite.snapshots.at(-1)?.messages ?? [];
    expect(last).toHaveLength(2);
    expect(last[0]!.id).not.toBe(last[1]!.id);
    polite.unsubscribe();
  });
});
