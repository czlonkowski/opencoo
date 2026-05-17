/**
 * Modal — shared modal shell (phase-a appendix #2; viewport-fit
 * + sticky-action-row in PR-W5 / phase-a appendix #11; migrated
 * to native `<dialog>` in PR-A1 / phase-a appendix #16).
 *
 * Why native `<dialog>`:
 *   - Free focus-trap. The browser keeps Tab + Shift-Tab inside
 *     the modal while it's open as a modal. No `focus-trap-react`,
 *     no `@reach/dialog`, no Radix (we don't ship `*-react` UI
 *     shims — wave-12 rule).
 *   - Free top-layer rendering. The modal sits above stacking
 *     contexts without z-index roulette.
 *   - Free `inert` on the rest of the page (the browser makes
 *     non-dialog DOM unreachable to assistive tech automatically).
 *   - Free Esc-to-close (fires `cancel` then `close`). We forward
 *     `cancel` to `onClose` and let the browser close the dialog
 *     natively — React + the consumer decide when to actually
 *     unmount (matches the legacy contract — consumers expect
 *     their `onClose` to drive the unmount).
 *
 * Backdrop click closes via target-equality on the `<dialog>`
 * itself (the `<dialog>` element fills its bounding box; clicks
 * outside its inner card region land on the dialog node, clicks
 * inside the card bubble up from descendants and the equality
 * check ignores them).
 *
 * Focus return: we capture `document.activeElement` synchronously
 * before calling `showModal()` and restore it on unmount. The
 * browser's own focus-trap returns focus to *some* element on
 * `close()` but doesn't guarantee the trigger; this ref pins
 * the contract.
 *
 * Firefox font-inheritance quirk: Firefox doesn't inherit
 * `font-family` onto `<dialog>` (mdn-known). We add an
 * explicit `dialog { font-family: inherit }` rule in `app.css`.
 *
 * Reduced motion: the 180ms `opencoo-dialog-enter` keyframe is
 * gated on `prefers-reduced-motion: no-preference`. When the
 * operator opts out, the dialog appears instantly.
 *
 * Design-system bindings (every visual references a CSS var from
 * `colors_and_type.css`; no literals):
 *   - sheet bg: var(--paper); border: 1px solid var(--ink);
 *     radius: var(--radius-xl)
 *   - backdrop tint: rgba(18,18,16,0.32) via the `dialog::backdrop`
 *     CSS rule in `app.css`. NO drop shadow. NO backdrop-blur.
 *   - sticky action row: var(--paper) bg + 1px solid var(--rule)
 *     top border (depth via line + mask, NOT shadow)
 *
 * API contract preserved from the pre-A1 shell:
 *   - same `ModalProps` (title, subtitle, children, onClose,
 *     initialFocusRef, maxWidth, actions)
 *   - same `data-modal-region` hooks ("body", "actions") so the
 *     ~14 existing consumers compile + render unchanged.
 */
import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

const DIALOG_STYLE: CSSProperties = {
  width: "100%",
  maxWidth: 520,
  // Hard cap on sheet height — `calc(100vh - 64px)` leaves 32px
  // breathing room top + bottom (matches the legacy backdrop
  // padding cue). Without this the sheet can grow taller than
  // the viewport, pushing the action row below the fold (the
  // wave-end Chrome QA finding 2026-05-09).
  maxHeight: "calc(100vh - 64px)",
  background: "var(--paper)",
  border: "1px solid var(--ink)",
  borderRadius: "var(--radius-xl)",
  // Padding moves to the inner regions so the sticky action row
  // can extend full-bleed to the sheet edge (the band visually
  // masks scrolling content right up to the modal border).
  padding: 0,
  display: "flex",
  flexDirection: "column",
  // `overflow: hidden` clips the rounded corners against the
  // scrollable body — without it the body's scrollbar-track can
  // poke past the rounded sheet corner.
  overflow: "hidden",
  color: "var(--fg-1)",
  // Reset UA dialog margin so flex centring (handled by the
  // browser via showModal()) lands on the sheet.
  margin: "auto",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  // Header keeps the original sheet padding so titles align with
  // the legacy layout.
  padding: "var(--space-6) var(--space-6) 0",
  // Don't let the header shrink — body scrolls, header stays put.
  flex: "0 0 auto",
};

// Body region wraps `props.children`. The load-bearing flex pair
// is `flex: 1 1 auto` + `min-height: 0`: without `min-height: 0`
// a flex child won't shrink below its content's intrinsic height,
// so `overflow-y: auto` would never trigger. This is the standard
// "scrollable child inside a flex column" recipe.
const BODY_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  padding: "var(--space-4) var(--space-6) var(--space-6)",
};

const BODY_STYLE_WITH_ACTIONS: CSSProperties = {
  ...BODY_STYLE,
  // Tighter bottom padding — the actions row carries its own
  // top/bottom padding so we don't double-up.
  paddingBottom: "var(--space-4)",
};

// Sticky-bottom action row. The `var(--paper)` background masks
// scrolling content beneath; the `1px solid var(--rule)` border
// is the depth cue (NOT a drop shadow — CLAUDE.md hard-no).
const ACTIONS_STYLE: CSSProperties = {
  position: "sticky",
  bottom: 0,
  flex: "0 0 auto",
  background: "var(--paper)",
  borderTop: "1px solid var(--rule)",
  padding: "var(--space-4) var(--space-6)",
};

const TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-h3)",
  lineHeight: "var(--lh-h3)",
  letterSpacing: "var(--tr-h3)",
  color: "var(--fg-1)",
  margin: 0,
};

const SUBTITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontWeight: 400,
  fontSize: "var(--fs-body)",
  lineHeight: "var(--lh-body)",
  color: "var(--fg-2)",
  margin: 0,
};

export interface ModalProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly onClose: () => void;
  /** Optional ref to the element that should receive focus when
   *  the modal mounts. Defaults to the modal container itself. */
  readonly initialFocusRef?: React.RefObject<HTMLElement>;
  /** Maximum width override — different modals carry different
   *  affordance. Defaults to 520px. */
  readonly maxWidth?: number;
  /** Optional sticky-bottom action row. Renders inside the sheet
   *  below the scrollable body so Cancel / Save / Confirm stay
   *  visible regardless of body height (PR-W5). Modals that don't
   *  pass `actions` still get the scrollable body — they just
   *  forfeit the sticky-bottom affordance. */
  readonly actions?: ReactNode;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Modal(props: ModalProps): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Remember the element that had focus before we opened, so we
  // can restore it after the dialog closes. Captured on the
  // first mount only — the consumer is expected to unmount the
  // <Modal /> to "close", which fires this effect's cleanup.
  const previousActiveRef = useRef<Element | null>(null);

  // Open the dialog as a true modal on mount; restore focus on
  // unmount. We keep this in a single effect so the "captured
  // active element" lifecycle is co-located with the showModal /
  // close pair — open-time + close-time are symmetrical.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    previousActiveRef.current = document.activeElement;
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        // Already-open dialog or non-modal context (test env).
        // Fall through; UI is still rendered.
      }
    }
    return (): void => {
      if (typeof dialog.close === "function" && dialog.open) {
        try {
          dialog.close();
        } catch {
          /* ignore — best-effort cleanup */
        }
      }
      const prev = previousActiveRef.current;
      if (prev instanceof HTMLElement && typeof prev.focus === "function") {
        // Re-focus the trigger so the keyboard operator lands back
        // where they were. Wrapped in a try because focus() can
        // throw on detached nodes.
        try {
          prev.focus();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  // Initial focus inside the dialog. Browsers auto-focus the
  // first focusable descendant of `<dialog>` on showModal(); if
  // the consumer passed `initialFocusRef`, honor that instead.
  useEffect(() => {
    const target = props.initialFocusRef?.current;
    if (target !== undefined && target !== null) {
      target.focus();
    }
  }, [props.initialFocusRef]);

  // Esc-to-close: the browser fires `cancel` when the operator
  // hits Escape. Default behavior is to close + remove `open`;
  // we let it close natively and forward the intent to `onClose`
  // so the consumer can unmount us. preventDefault would block
  // the close — we want the unmount to drive close, so we DO NOT
  // preventDefault here.
  const onClose = props.onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const handler = (): void => onClose();
    dialog.addEventListener("cancel", handler);
    return (): void => dialog.removeEventListener("cancel", handler);
  }, [onClose]);

  const dialogStyle: CSSProperties = {
    ...DIALOG_STYLE,
    ...(props.maxWidth !== undefined ? { maxWidth: props.maxWidth } : {}),
  };

  const hasActions = props.actions !== undefined;
  const bodyStyle = hasActions ? BODY_STYLE_WITH_ACTIONS : BODY_STYLE;

  // Reduced-motion: skip the dialog-enter keyframe entirely.
  // The check runs at render time; the operator's preference is
  // stable enough for a one-shot animation we evaluate once.
  const enterClass = prefersReducedMotion() ? "" : "opencoo-dialog-enter";

  return (
    <dialog
      ref={dialogRef}
      // Native <dialog> has implicit role="dialog"; we set it
      // explicitly for older AT + for testing-library role
      // queries that walk attributes first.
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className={enterClass}
      style={dialogStyle}
      onClick={(e): void => {
        // Click on the <dialog> element itself (backdrop region)
        // closes; clicks on descendants bubble up but the
        // target-equality guard ignores them.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={HEADER_STYLE}>
        <h2 id={titleId} style={TITLE_STYLE}>
          {props.title}
        </h2>
        {props.subtitle !== undefined ? (
          <p style={SUBTITLE_STYLE}>{props.subtitle}</p>
        ) : null}
      </div>
      <div data-modal-region="body" style={bodyStyle}>
        {props.children}
      </div>
      {hasActions ? (
        <div data-modal-region="actions" style={ACTIONS_STYLE}>
          {props.actions}
        </div>
      ) : null}
    </dialog>
  );
}
