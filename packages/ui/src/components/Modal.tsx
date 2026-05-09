/**
 * Modal — shared modal shell (phase-a appendix #2; viewport-fit
 * + sticky-action-row in PR-W5 / phase-a appendix #11).
 *
 * Extracted from PatEntryModal / DiffPreviewDialog so the
 * `+ New domain` and `+ New binding` modals don't duplicate
 * the backdrop / dialog / Esc-handler shape. Pure presentational —
 * the children compose the form body. The shell:
 *   - renders a flat ink-tinted overlay (NO backdrop-blur)
 *   - sets role='dialog' + aria-modal + aria-labelledby
 *   - traps Esc and fires `onClose`
 *   - applies the design-system paper card with border-elevation
 *   - clamps sheet height to `calc(100vh - 64px)` so it never
 *     overflows the viewport (32px breathing room top + bottom)
 *   - scrolls the body region via `overflow-y: auto`
 *   - renders an optional `actions` slot as a sticky-bottom row
 *     with `var(--paper)` background and `1px solid var(--rule)`
 *     border-top so it stays visible when the body scrolls
 *
 * Hard-nos honored (CLAUDE.md design system):
 *   - NO drop shadows for elevation — depth = border + bg shift
 *   - NO backdrop-blur / frosted glass
 *   - NO motion on the sticky row (depth cue is `--rule` line +
 *     `--paper` mask, not a shadow / shimmer)
 *   - NO emoji / no marketing voice
 *
 * The shell intentionally does NOT do focus-trap heroics —
 * keeping the implementation small. Each modal that needs
 * tabbable elements can use the `initialFocusRef` prop to
 * focus the first interactive element on open. Esc-to-close
 * is the keyboard mode every dialog supports.
 *
 * Why an explicit `actions` prop (PR-W5):
 *   The wave-10 consumers (DomainDetail, SourceBindingDetail,
 *   ImpactPreviewDialog, NewDomainModal, NewSourceBindingModal)
 *   nest their footer inside a single `<div SECTION_STYLE>` child
 *   block alongside the form body. With a single child block we
 *   can't `position: sticky` the last child generically — the
 *   footer is grandchild, not direct child. The `actions` prop is
 *   the smallest contract that lets the shell own sticky-bottom
 *   behavior without dictating how consumers structure their body.
 */
import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(18, 18, 16, 0.32)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--space-5)",
  zIndex: 100,
};

const MODAL_STYLE: CSSProperties = {
  width: "100%",
  maxWidth: 520,
  // Hard cap on sheet height — `calc(100vh - 64px)` leaves 32px
  // breathing room top + bottom. Without this the sheet can grow
  // taller than the viewport, pushing the action row below the
  // fold (the wave-end Chrome QA finding 2026-05-09).
  maxHeight: "calc(100vh - 64px)",
  background: "var(--paper)",
  border: "1px solid var(--ink)",
  borderRadius: "var(--radius-xl)",
  // Padding moves to the inner regions so the sticky action row
  // can extend full-bleed to the sheet edge (the band visually
  // masks scrolling content right up to the modal border).
  display: "flex",
  flexDirection: "column",
  // `overflow: hidden` clips the rounded corners against the
  // scrollable body — without it the body's scrollbar-track can
  // poke past the rounded sheet corner.
  overflow: "hidden",
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
  // Same horizontal padding as the legacy single-padded sheet.
  // Top padding restores the gap between the header and the
  // first body element. Bottom padding shrinks to space-4 when
  // an actions slot follows; otherwise the body keeps space-6
  // bottom padding so an actions-less modal looks identical to
  // the pre-PR-W5 shell.
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

export function Modal(props: ModalProps): JSX.Element {
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  // Esc-to-close. Listen on document so the handler fires
  // regardless of where focus currently sits inside the modal.
  // Dep on `props.onClose` only (not the whole `props` object) so
  // the listener doesn't churn on every render — title/initialFocus
  // changes shouldn't re-bind the global keydown handler.
  const onClose = props.onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return (): void => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Initial focus.
  useEffect(() => {
    const el = props.initialFocusRef?.current ?? containerRef.current;
    el?.focus();
  }, [props.initialFocusRef]);

  const modalStyle: CSSProperties = {
    ...MODAL_STYLE,
    ...(props.maxWidth !== undefined ? { maxWidth: props.maxWidth } : {}),
  };

  const hasActions = props.actions !== undefined;
  const bodyStyle = hasActions ? BODY_STYLE_WITH_ACTIONS : BODY_STYLE;

  return (
    <div
      style={BACKDROP_STYLE}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e): void => {
        // Click on the backdrop (NOT the modal card) closes.
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className="opencoo-dialog-enter"
        style={modalStyle}
        onClick={(e): void => e.stopPropagation()}
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
      </div>
    </div>
  );
}
