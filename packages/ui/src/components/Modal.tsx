/**
 * Modal — shared modal shell (phase-a appendix #2).
 *
 * Extracted from PatEntryModal / DiffPreviewDialog so the
 * `+ New domain` and `+ New binding` modals don't duplicate
 * the backdrop / dialog / Esc-handler shape. Pure presentational —
 * the children compose the form body. The shell:
 *   - renders a flat ink-tinted overlay (NO backdrop-blur)
 *   - sets role='dialog' + aria-modal + aria-labelledby
 *   - traps Esc and fires `onClose`
 *   - applies the design-system paper card with border-elevation
 *
 * Hard-nos honored (CLAUDE.md design system):
 *   - NO drop shadows for elevation — depth = border + bg shift
 *   - NO backdrop-blur / frosted glass
 *   - NO emoji / no marketing voice
 *
 * The shell intentionally does NOT do focus-trap heroics —
 * keeping the implementation small. Each modal that needs
 * tabbable elements can use the `initialFocusRef` prop to
 * focus the first interactive element on open. Esc-to-close
 * is the keyboard mode every dialog supports.
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
  background: "var(--paper)",
  border: "1px solid var(--ink)",
  borderRadius: "var(--radius-xl)",
  padding: "var(--space-6)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
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
        <div
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
        >
          <h2 id={titleId} style={TITLE_STYLE}>
            {props.title}
          </h2>
          {props.subtitle !== undefined ? (
            <p style={SUBTITLE_STYLE}>{props.subtitle}</p>
          ) : null}
        </div>
        {props.children}
      </div>
    </div>
  );
}
