/**
 * `pushAnnouncement` — module-scoped live-region queue.
 *
 * PR-A4 (wave-16, phase-a appendix #16). Global aria-live wiring
 * so async events (loading start/end, save success, validation
 * failure, fetch errors) get narrated by screen readers without
 * every call site having to mount its own polite/assertive
 * region pair.
 *
 * Two independent channels — `polite` and `assertive` — back
 * the two `<div aria-live>`s mounted once at the App root
 * (`App.tsx`). Call sites use `pushAnnouncement(text, opts?)`;
 * the `<App>`-level regions subscribe and re-render their text
 * content. The SR-only region nodes never enter the focus order
 * and never paint (they carry the `SR_ONLY_STYLE` recipe from
 * `Chrome.tsx`).
 *
 * Design choices pinned by tests:
 *   - **No React deps in this file** — the queue is pure JS so
 *     non-React surfaces (e.g. fetch error handlers in
 *     `lib/api.ts`) can call `pushAnnouncement` without dragging
 *     in a hook context.
 *   - **No replay to late subscribers** — a subscriber added
 *     after a push does not retroactively receive its handler
 *     call. The subscriber list is "future events only"; the
 *     mounted region still reads the current queue on its next
 *     render. This keeps SR-only region nodes idempotent across
 *     React reconciler swaps — a Suspense fallback flicker won't
 *     re-narrate every pending toast.
 *   - **Auto-remove on a per-message timer** (default 8000ms;
 *     overridable per call). The region renders only what's
 *     currently queued; after the timer fires the message slides
 *     out of the array and subscribers get a fresh empty-state
 *     snapshot.
 *   - **Unique id per push** — even when the text repeats, the
 *     monotonic counter gives each message a stable identity so
 *     React keys are predictable and `aria-atomic` re-narrations
 *     of identical strings remain observable to assistive tech.
 *
 * Security (THREAT-MODEL §5): call sites that surface server-
 * originated error strings MUST run them through `safeErrorMessage`
 * from `lib/safe-error.ts` BEFORE handing the result to
 * `pushAnnouncement`. The Toast bridge (`Toast.tsx`) trusts its
 * own callers' inputs verbatim — the same THREAT-MODEL §5
 * contract Toast carries. This module never scrubs.
 */

/** Polite = routine status (loading, saved). Assertive = errors. */
export type AnnouncementTone = "polite" | "assertive";

export interface LiveAnnouncement {
  readonly id: string;
  readonly text: string;
}

export interface PushAnnouncementOpts {
  readonly tone?: AnnouncementTone;
  readonly timeoutMs?: number;
}

type Subscriber = (messages: readonly LiveAnnouncement[]) => void;

interface ChannelState {
  messages: LiveAnnouncement[];
  subscribers: Set<Subscriber>;
}

const DEFAULT_TIMEOUT_MS = 8000;

const channels: Record<AnnouncementTone, ChannelState> = {
  polite: { messages: [], subscribers: new Set() },
  assertive: { messages: [], subscribers: new Set() },
};

/** Monotonic id counter — `crypto.randomUUID` is unavailable in
 *  JSDOM by default, and a counter is enough for in-process key
 *  stability. */
let seq = 0;

function notify(channel: ChannelState): void {
  // Snapshot so a subscriber that synchronously calls
  // `pushAnnouncement` (e.g. chaining) cannot mutate the array
  // we hand to the rest of the listeners mid-iteration.
  const snapshot = channel.messages.slice();
  for (const fn of channel.subscribers) {
    fn(snapshot);
  }
}

/**
 * Push a status message to one of the two live regions.
 *
 * `tone` defaults to `'polite'`. `timeoutMs` defaults to 8000ms.
 * Always returns void — call sites do NOT await dismissal.
 */
export function pushAnnouncement(
  text: string,
  opts?: PushAnnouncementOpts,
): void {
  const tone = opts?.tone ?? "polite";
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const channel = channels[tone];
  seq += 1;
  const id = `announce-${seq}`;
  const message: LiveAnnouncement = { id, text };
  channel.messages.push(message);
  notify(channel);
  // Schedule removal. `setTimeout` here intentionally outlives
  // any single component lifecycle — the queue is module-scoped
  // and is what makes the live region survive a Suspense
  // reconcile of the App subtree.
  setTimeout((): void => {
    const idx = channel.messages.findIndex((m) => m.id === id);
    if (idx >= 0) {
      channel.messages.splice(idx, 1);
      notify(channel);
    }
  }, timeoutMs);
}

/**
 * Subscribe to the queue for a given tone. The handler is called
 * on every subsequent push or remove with the current message
 * snapshot. Subscribers are NOT invoked synchronously on
 * subscribe — the App regions read the current queue on their
 * own initial render via `getAnnouncementsSnapshot`.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToAnnouncements(
  tone: AnnouncementTone,
  fn: Subscriber,
): () => void {
  const channel = channels[tone];
  channel.subscribers.add(fn);
  return (): void => {
    channel.subscribers.delete(fn);
  };
}

/** Current snapshot for a given tone — used by the App-level
 *  region components on initial render so the first paint
 *  reflects any pre-mount pushes (e.g. a token-binding error
 *  fired before the route shell mounted). */
export function getAnnouncementsSnapshot(
  tone: AnnouncementTone,
): readonly LiveAnnouncement[] {
  return channels[tone].messages.slice();
}

/** Test-only helper: clear both channels + the id counter so a
 *  preceding test cannot leak state into the next one. Vitest's
 *  `vi.useFakeTimers()` doesn't drain in-flight setTimeouts, so
 *  we ALSO clear the messages array on demand. (Real timers do
 *  drain on the macrotask tick during `useRealTimers()`, but the
 *  channels persist across files.) */
export function __resetAnnouncementsForTests(): void {
  channels.polite.messages = [];
  channels.assertive.messages = [];
  channels.polite.subscribers.clear();
  channels.assertive.subscribers.clear();
  seq = 0;
}
