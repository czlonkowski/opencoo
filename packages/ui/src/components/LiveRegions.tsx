/**
 * `LiveRegions` — the two App-level aria-live regions.
 *
 * PR-A4 (wave-16, phase-a appendix #16). Renders a polite and an
 * assertive `<div aria-live>` once at the top of the App tree;
 * each subscribes to `lib/announce.ts` and reflects the matching
 * channel's current queue as visible text. The regions never
 * paint visually (they carry the `SR_ONLY_STYLE` recipe) and are
 * never in the focus order — they exist purely so assistive tech
 * narrates the announcements pushed via `pushAnnouncement(...)`.
 *
 * `aria-atomic="true"` so the screen reader re-reads the entire
 * region text every time it changes — without this, a push that
 * REPLACED a prior message would only narrate the diff (which is
 * not what we want for status/error narration).
 *
 * Each region is rendered exactly once; we use stable ids so the
 * App-level pin in `App.tsx` tests can assert their presence.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SR_ONLY_STYLE } from "./Chrome.js";
import {
  getAnnouncementsSnapshot,
  subscribeToAnnouncements,
  type AnnouncementTone,
  type LiveAnnouncement,
} from "../lib/announce.js";

/** Stable DOM ids — the App-level test asserts both are present. */
export const POLITE_REGION_ID = "opencoo-aria-live-polite";
export const ASSERTIVE_REGION_ID = "opencoo-aria-live-assertive";

function LiveRegion(props: {
  readonly tone: AnnouncementTone;
  readonly id: string;
  readonly ariaLabel: string;
}): JSX.Element {
  const [messages, setMessages] = useState<readonly LiveAnnouncement[]>(
    (): readonly LiveAnnouncement[] => getAnnouncementsSnapshot(props.tone),
  );
  useEffect((): (() => void) => {
    return subscribeToAnnouncements(props.tone, (next): void => {
      setMessages(next);
    });
  }, [props.tone]);
  return (
    <div
      id={props.id}
      role="status"
      aria-live={props.tone}
      aria-atomic="true"
      aria-label={props.ariaLabel}
      style={SR_ONLY_STYLE}
    >
      {messages.map((m) => (
        <div key={m.id}>{m.text}</div>
      ))}
    </div>
  );
}

/**
 * Mount once near the App root. Two channels:
 *   - polite — routine status (loading, success).
 *   - assertive — errors.
 *
 * The visible toast region (`ToastRegion`) renders its own
 * per-toast `role="status"` / `role="alert"`; this global live
 * region is the *bridge* for assistive tech that listens for
 * the page-level aria-live attributes. The two are complementary
 * — the toast lives at a fixed visual location; the live region
 * lives at a fixed semantic location.
 */
export function LiveRegions(): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <LiveRegion
        tone="polite"
        id={POLITE_REGION_ID}
        ariaLabel={t("aria.live.polite")}
      />
      <LiveRegion
        tone="assertive"
        id={ASSERTIVE_REGION_ID}
        ariaLabel={t("aria.live.assertive")}
      />
    </>
  );
}
