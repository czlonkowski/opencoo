/**
 * Tooltip — per-term operator help on jargon-heavy surfaces
 * (PR-C1, wave-16 / phase-a appendix #16).
 *
 * Two patterns:
 *   - <Tooltip term="reviewMode">Review mode</Tooltip> — block
 *     form. Wraps a label and renders the `?` button after it.
 *   - <TooltipTrigger term="reviewMode" /> — inline form.
 *     Renders only the `?` button (for callsites where the label
 *     is already in the DOM, e.g. <Field> wired via composition).
 *
 * Affordance choice (per the wave-16 scoping doc — "Cross-cutting
 * design decisions §`?` over fourth glyph for tooltip trigger"):
 * the trigger is a typographic `?` rendered in JetBrains Mono at
 * micro size. The Glyph trio (OpenArc / FilledDisc / RingWithDot)
 * is reserved for product-concept iconography; UI affordances use
 * type. We deliberately do NOT add a fourth glyph.
 *
 * Library choice: `@floating-ui/react` is a positioning utility,
 * not a component framework. The wave-12 "no `*-react` UI shims"
 * rule rejected Radix / focus-trap-react / @reach — those are
 * component frameworks (they own the markup contract). Floating
 * UI gives us collision detection (flip + shift) without owning
 * the trigger element or the bubble's structure.
 *
 * i18n contract: the per-term label + body live in the `help.<term>`
 * namespace. The button's `aria-label` is "About {{term-label}}"
 * via `tooltip.about`. The bubble renders the body string in the
 * operator's locale; falls back to English per react-i18next's
 * fallbackLng setting.
 */
import {
  useFloating,
  useDismiss,
  useFocus,
  useHover,
  useInteractions,
  useRole,
  flip,
  shift,
  offset,
  autoUpdate,
  safePolygon,
  FloatingPortal,
} from "@floating-ui/react";
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

const TRIGGER_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  marginLeft: 6,
  padding: 0,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  lineHeight: 1,
  color: "var(--ink-3)",
  background: "var(--paper-2)",
  borderStyle: "solid",
  borderWidth: 1,
  borderColor: "var(--paper-3)",
  borderRadius: "var(--radius-s)",
  cursor: "help",
  verticalAlign: "middle",
};

const BUBBLE_STYLE: CSSProperties = {
  maxWidth: 280,
  padding: "var(--space-2) var(--space-3)",
  background: "var(--ink)",
  color: "var(--paper)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  lineHeight: "var(--lh-small)",
  borderRadius: "var(--radius-m)",
  // Z-stack above modals (Modal uses zIndex 100; sticky action row
  // is positioned inside the modal). The portal lifts the bubble
  // to <body> so it cannot be clipped by `overflow: hidden` on
  // ancestors, but we still need a higher z-index than the modal
  // backdrop.
  zIndex: 200,
};

export interface TooltipTriggerProps {
  /** Term key under the `help.*` i18n namespace. The `aria-label`
   *  reads `t("help.<term>.label")` and the bubble shows
   *  `t("help.<term>.body")`. */
  readonly term: string;
}

export interface TooltipProps extends TooltipTriggerProps {
  /** The label or other content the `?` button sits next to. */
  readonly children: ReactNode;
}

/**
 * Shared hook — wires `@floating-ui/react` interactions so the
 * trigger opens on hover (200ms delay) + focus, closes on
 * blur/Esc/outside-press, and the bubble has stable
 * `role="tooltip"` semantics.
 */
function useTooltipFloating(): {
  readonly open: boolean;
  readonly refs: ReturnType<typeof useFloating>["refs"];
  readonly floatingStyles: ReturnType<typeof useFloating>["floatingStyles"];
  readonly getReferenceProps: ReturnType<
    typeof useInteractions
  >["getReferenceProps"];
  readonly getFloatingProps: ReturnType<
    typeof useInteractions
  >["getFloatingProps"];
  readonly bubbleId: string;
} {
  const [open, setOpen] = useState(false);
  const bubbleId = useId();

  const floating = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "top",
    whileElementsMounted: autoUpdate,
    // 8px breathing room between the `?` and the bubble; `flip`
    // pushes the bubble above when there's no room below + back
    // below when there's no room above; `shift` slides it inside
    // the viewport on narrow surfaces.
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  });

  const hover = useHover(floating.context, {
    delay: { open: 200, close: 0 },
    // `safePolygon` lets the operator move from the trigger to the
    // bubble (e.g. to copy text from it) without the bubble
    // disappearing mid-traversal. Negligible runtime cost.
    handleClose: safePolygon(),
  });
  const focus = useFocus(floating.context);
  const dismiss = useDismiss(floating.context, {
    escapeKey: true,
    outsidePress: true,
  });
  const role = useRole(floating.context, { role: "tooltip" });

  const interactions = useInteractions([hover, focus, dismiss, role]);

  return {
    open,
    refs: floating.refs,
    floatingStyles: floating.floatingStyles,
    getReferenceProps: interactions.getReferenceProps,
    getFloatingProps: interactions.getFloatingProps,
    bubbleId,
  };
}

/**
 * Inline trigger — renders the `?` button only. Use this when the
 * label is already in the DOM and you just want to attach a help
 * affordance to it.
 */
export function TooltipTrigger(props: TooltipTriggerProps): JSX.Element {
  const { t } = useTranslation();
  const ttf = useTooltipFloating();
  const label = t(`help.${props.term}.label`);
  const body = t(`help.${props.term}.body`);

  return (
    <>
      <button
        type="button"
        ref={ttf.refs.setReference}
        aria-label={t("tooltip.about", { term: label })}
        aria-describedby={ttf.open ? ttf.bubbleId : undefined}
        style={TRIGGER_STYLE}
        {...ttf.getReferenceProps()}
      >
        ?
      </button>
      {ttf.open ? (
        <FloatingPortal>
          <div
            ref={ttf.refs.setFloating}
            id={ttf.bubbleId}
            style={{
              ...BUBBLE_STYLE,
              ...ttf.floatingStyles,
            }}
            {...ttf.getFloatingProps()}
          >
            {body}
          </div>
        </FloatingPortal>
      ) : null}
    </>
  );
}

/**
 * Block form — wraps a label and appends the `?` button after it.
 * Use this in form-field labels where you want the operator to
 * see "Label ?" with the trigger sitting flush against the label.
 */
export function Tooltip(props: TooltipProps): JSX.Element {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
      }}
    >
      {props.children}
      <TooltipTrigger term={props.term} />
    </span>
  );
}
