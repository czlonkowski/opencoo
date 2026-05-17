/**
 * Toast queue + `useToast` hook — global success/advisory/alert
 * surface (PR-B7, wave-16, phase-a appendix #16).
 *
 * Three tones, each with a fixed visual contract:
 *   - `success` → left-border `--healthy` + tone tag `OK`
 *   - `advisory` → left-border `--advisory` + tone tag `ADVISORY`
 *   - `alert`   → left-border `--alert` + tone tag `ALERT`
 *
 * Each `useToast()` method takes either a string (simple message)
 * or an opts object `{ message, details?, durationMs?, sticky? }`.
 * `details` renders inside a collapsible "Show details" toggle as
 * mono pre-formatted text — the call site is responsible for
 * cleaning the body (e.g. shaping a 422 ZodError into a stable
 * field-by-field string) before passing it; Toast just renders.
 *
 * Auto-dismiss defaults to 6000ms with hover/focus pause-and-
 * resume — the timer carries the *remaining* duration, not a
 * fixed end-time, so the toast doesn't snap away the instant the
 * operator un-hovers a long-dwelt toast. Sticky toasts never
 * auto-dismiss; the operator must click the explicit "Dismiss"
 * button.
 *
 * ARIA: `alert` tone renders `role="alert"` (assertive),
 * success/advisory render `role="status"` (polite). A4 (Phase 3
 * of wave-16) will layer a global live region on top; per-toast
 * roles already complement that. The region itself is
 * `role="region"` + `aria-label={t('toast.region')}` so screen
 * readers can list it as a navigable landmark.
 *
 * Hard-nos honored (CLAUDE.md design system):
 *   - No emoji in any rendered text (tone tags use JetBrains
 *     Mono micro labels: "OK" / "ADVISORY" / "ALERT").
 *   - No drop shadows — depth is `--paper` background + 1px
 *     `--paper-3` border on three sides + the tone-colored
 *     left-border.
 *   - No fully-rounded surfaces — `--radius-m` (4px).
 *   - No animation: mount is an instant insert and dismiss is
 *     an instant remove. The component emits no inline
 *     `animation` or `transition` styles (a unit test pins this
 *     against re-introducing a shimmer/pulse loop). The plan-
 *     appendix §B7 brief originally specified one-shot
 *     `--ease-write` slide-in + fade-out for mount/dismiss, but
 *     implementing real enter/exit transitions requires an
 *     "exiting" state on the reducer + a per-toast unmount-after-
 *     animation timer; that machinery was deferred because the
 *     test-pinned no-loop invariant already satisfies the
 *     design-system "exactly one loop" rule and `prefers-reduced-
 *     motion` (which would otherwise need a second clamp here).
 *     A4 (Phase 3) lands the live-region wiring next and is the
 *     natural place to revisit enter/exit motion if needed.
 *   - No gradients, no backdrop-blur.
 *
 * Security: `safeErrorMessage` from `lib/safe-error.ts` must be
 * used by call sites that surface a fetch error's `.message`
 * verbatim. Toast itself does not scrub — the call site owns
 * the boundary (THREAT-MODEL §5 PR checklist).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { pushAnnouncement } from "../lib/announce.js";

type Tone = "success" | "advisory" | "alert";

interface ToastOpts {
  readonly message: string;
  readonly details?: string;
  readonly durationMs?: number;
  readonly sticky?: boolean;
}

type ToastInput = string | ToastOpts;

interface InternalToast {
  readonly id: string;
  readonly tone: Tone;
  readonly message: string;
  readonly details: string | null;
  /** Total visible-time budget in ms; `null` for sticky toasts. */
  readonly durationMs: number | null;
}

interface ToastApi {
  readonly success: (input: ToastInput) => void;
  readonly advisory: (input: ToastInput) => void;
  readonly alert: (input: ToastInput) => void;
}

const DEFAULT_DURATION_MS = 6000;

interface State {
  readonly toasts: readonly InternalToast[];
}

type Action =
  | { readonly type: "push"; readonly toast: InternalToast }
  | { readonly type: "dismiss"; readonly id: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "push":
      return { toasts: [...state.toasts, action.toast] };
    case "dismiss":
      return {
        toasts: state.toasts.filter((t) => t.id !== action.id),
      };
  }
}

function normalizeInput(input: ToastInput): {
  readonly message: string;
  readonly details: string | null;
  readonly durationMs: number | null;
} {
  if (typeof input === "string") {
    return { message: input, details: null, durationMs: DEFAULT_DURATION_MS };
  }
  const sticky = input.sticky === true;
  return {
    message: input.message,
    details: input.details ?? null,
    durationMs: sticky ? null : input.durationMs ?? DEFAULT_DURATION_MS,
  };
}

interface ToastContextShape {
  readonly state: State;
  readonly push: (
    tone: Tone,
    payload: {
      readonly message: string;
      readonly details: string | null;
      readonly durationMs: number | null;
    },
  ) => void;
  readonly dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextShape | null>(null);

/**
 * Wraps the app so any descendant can call `useToast()`. Keeps
 * state in a reducer (push / dismiss only) so the API surface
 * stays small and the timer logic lives in the per-toast
 * `<ToastItem>` — moving the timer into the reducer would
 * require side-effects inside the reducer, which React 19
 * dev-mode catches and warns about. (Reducers must be pure.)
 */
export function ToastProvider(props: {
  readonly children: ReactNode;
}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, { toasts: [] });

  // Monotonic id generator — `useId` is per-component, not per-
  // event, so we keep a counter alongside it. `crypto.randomUUID`
  // is unavailable in JSDOM by default; this avoids the import.
  const seqRef = useRef(0);

  const push = useCallback(
    (
      tone: Tone,
      payload: {
        readonly message: string;
        readonly details: string | null;
        readonly durationMs: number | null;
      },
    ): void => {
      seqRef.current += 1;
      dispatch({
        type: "push",
        toast: {
          id: `toast-${seqRef.current}`,
          tone,
          message: payload.message,
          details: payload.details,
          durationMs: payload.durationMs,
        },
      });
      // PR-A4 (wave-16) — bridge to the global aria-live regions.
      // The toast itself already carries `role=status`/`role=alert`
      // + `aria-live`, but the toast is portalled to a visual
      // location at the bottom-right of the viewport; some screen
      // readers (and some operator setups) listen only to the
      // App-level aria-live regions. Mirroring every toast push
      // into the announcement queue guarantees the message is
      // narrated regardless of which region the operator's AT
      // happens to monitor. We pass ONLY the message string —
      // details ride a collapsed `<pre>` and would be too long /
      // too structurally complex to narrate as a single utterance.
      // No scrubbing: the call site already passed a safe string
      // (THREAT-MODEL §5; same contract Toast itself trusts).
      pushAnnouncement(payload.message, {
        tone: tone === "alert" ? "assertive" : "polite",
      });
    },
    [],
  );

  const dismiss = useCallback((id: string): void => {
    dispatch({ type: "dismiss", id });
  }, []);

  return (
    <ToastContext.Provider value={{ state, push, dismiss }}>
      {props.children}
    </ToastContext.Provider>
  );
}

/**
 * Hook returning `{ success, advisory, alert }`. Each method
 * accepts a string or an opts object; the call site never sees
 * the internal `InternalToast` shape.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error(
      "useToast must be called inside <ToastProvider>. Mount <ToastProvider> at the App root.",
    );
  }
  const { push } = ctx;
  return {
    success: (input: ToastInput): void =>
      push("success", normalizeInput(input)),
    advisory: (input: ToastInput): void =>
      push("advisory", normalizeInput(input)),
    alert: (input: ToastInput): void => push("alert", normalizeInput(input)),
  };
}

/**
 * Renders the queued toasts as a fixed bottom-right stack. Mount
 * exactly once near the App root (see `App.tsx`).
 *
 * Uses `createPortal` to lift the stack to `document.body` so
 * surrounding `overflow: hidden` containers (Card / Modal body)
 * cannot clip the toast.
 */
export function ToastRegion(): JSX.Element | null {
  const ctx = useContext(ToastContext);
  const { t } = useTranslation();
  if (ctx === null) {
    // Best-effort fallback — if the region is rendered outside a
    // provider, render nothing rather than throwing. The hook
    // throws so call sites get a clear error; the region is the
    // less-critical half.
    return null;
  }
  // SSR / pre-mount safety. The portal target is `document.body`;
  // during SSR `document` is undefined.
  if (typeof document === "undefined") return null;

  const region = (
    <ol
      role="region"
      aria-label={t("toast.region")}
      style={REGION_STYLE}
    >
      {ctx.state.toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          // `ctx.dismiss` is `useCallback`-stable (it dispatches
          // a reducer action — no closed-over rendered state).
          // Passing it down + the id separately lets `<ToastItem>`
          // keep its dismiss-timer `useEffect` dependency list
          // tight (Copilot triage on PR-B7 — without this, every
          // re-render of ToastRegion would form a fresh inline
          // closure and `<ToastItem>`'s effect would clear + re-
          // arm the timer on every keystroke elsewhere in the app).
          dismiss={ctx.dismiss}
        />
      ))}
    </ol>
  );
  return createPortal(region, document.body);
}

/* ============================================================
 * Per-toast item.
 *
 * Owns its own dismiss timer so the auto-dismiss math (pause on
 * hover, resume from the *remaining* duration on leave) doesn't
 * spread into the global reducer. When the timer fires it calls
 * `onDismiss`, which dispatches a `dismiss` action in the
 * reducer; on unmount we clear the pending timer so a delayed
 * dispatch can't try to update an unmounted tree.
 * ============================================================ */
function ToastItem(props: {
  readonly toast: InternalToast;
  /** Stable reference (`useCallback` over `dispatch({type:"dismiss"})`)
   *  so the dismiss-timer effect can list it as a dep without
   *  thrashing the timer on every parent re-render. */
  readonly dismiss: (id: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { toast, dismiss } = props;
  const [showDetails, setShowDetails] = useState(false);
  const [paused, setPaused] = useState(false);
  // `remainingRef` carries the un-expired portion of the toast's
  // budget. On hover we freeze it; on leave we restart the timer
  // from the frozen value — never from the original budget.
  const remainingRef = useRef<number | null>(toast.durationMs);
  // `tickStartRef` is the wall-clock time the current timer
  // started, used to compute "elapsed since hover started".
  const tickStartRef = useRef<number>(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect((): (() => void) => {
    // Sticky toasts have no timer.
    if (toast.durationMs === null) {
      return (): void => undefined;
    }
    if (paused || remainingRef.current === null || remainingRef.current <= 0) {
      return (): void => undefined;
    }
    tickStartRef.current = Date.now();
    timerRef.current = setTimeout((): void => {
      dismiss(toast.id);
    }, remainingRef.current);
    return (): void => {
      if (timerRef.current !== null) {
        // Snapshot how much of the *current* arm-cycle elapsed
        // before unmount / re-pause; that elapsed slice must NOT
        // get re-counted when we resume.
        const elapsed = Date.now() - tickStartRef.current;
        if (remainingRef.current !== null && elapsed > 0) {
          remainingRef.current = Math.max(0, remainingRef.current - elapsed);
        }
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // Deps are exactly the values the effect closes over.
    // `dismiss` is `useCallback`-stable from the provider (Copilot
    // triage); `toast.id` + `toast.durationMs` are pinned on push;
    // `paused` flips on hover/focus. No `props` object in deps —
    // that would re-fire on every parent render (Copilot triage).
  }, [paused, toast.durationMs, toast.id, dismiss]);

  const onMouseEnter = useCallback((): void => {
    setPaused(true);
  }, []);
  const onMouseLeave = useCallback((): void => {
    setPaused(false);
  }, []);
  // Keyboard parity: focus pauses, blur resumes — but only when
  // focus leaves the toast entirely. `onFocus` / `onBlur` bubble
  // in React (focusin / focusout semantics), so moving focus
  // between descendants (Dismiss → Show details → Dismiss) would
  // otherwise fire spurious blur/focus pairs and resume the timer
  // mid-interaction (Copilot triage on PR-B7).
  const onFocus = useCallback(
    (e: React.FocusEvent<HTMLLIElement>): void => {
      // `relatedTarget` is where focus is moving FROM; if it was
      // outside this `<li>`, we're entering the toast → pause.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setPaused(true);
      }
    },
    [],
  );
  const onBlur = useCallback(
    (e: React.FocusEvent<HTMLLIElement>): void => {
      // `relatedTarget` is where focus is moving TO; if it's
      // still inside the toast, we're moving between descendants
      // → keep paused. Only resume when focus has left the toast.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setPaused(false);
      }
    },
    [],
  );

  const tone = TONE_STYLES[toast.tone];
  const role = toast.tone === "alert" ? "alert" : "status";

  const onDismissClick = useCallback((): void => {
    dismiss(toast.id);
  }, [dismiss, toast.id]);

  return (
    <li
      role={role}
      // aria-live mirrors the role's default politeness so the
      // region announces immediately for alerts and politely for
      // success/advisory — matching A4's eventual global region.
      aria-live={toast.tone === "alert" ? "assertive" : "polite"}
      aria-atomic="true"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      style={{
        ...TOAST_BASE_STYLE,
        borderLeft: `3px solid ${tone.accent}`,
      }}
    >
      <div style={TOAST_HEADER_STYLE}>
        <span
          style={{
            ...TONE_TAG_STYLE,
            color: tone.accent,
          }}
        >
          {tone.label}
        </span>
        <span style={TOAST_MESSAGE_STYLE}>{toast.message}</span>
        <button
          type="button"
          aria-label={t("toast.dismiss")}
          onClick={onDismissClick}
          style={DISMISS_BTN_STYLE}
        >
          {/* Times-glyph rendered as a typographic character so
           *  we never ship an emoji. */}
          ×
        </button>
      </div>
      {toast.details !== null ? (
        <ToastDetails
          details={toast.details}
          showDetails={showDetails}
          onToggle={(): void => setShowDetails((v) => !v)}
        />
      ) : null}
    </li>
  );
}

function ToastDetails(props: {
  readonly details: string;
  readonly showDetails: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div style={DETAILS_WRAP_STYLE}>
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.showDetails}
        aria-controls={id}
        style={DETAILS_TOGGLE_STYLE}
      >
        {t("toast.showDetails")}
      </button>
      {props.showDetails ? (
        <pre id={id} style={DETAILS_PRE_STYLE}>
          {props.details}
        </pre>
      ) : null}
    </div>
  );
}

/* ============================================================
 * Styles — kept as plain `CSSProperties` objects so they
 * inherit the design-system token contract without touching
 * the global stylesheet.
 * ============================================================ */

const REGION_STYLE: CSSProperties = {
  position: "fixed",
  bottom: "var(--space-4)",
  right: "var(--space-4)",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: "var(--space-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
  zIndex: 250,
  pointerEvents: "none",
  // The portal owns no width — each toast clamps itself; the
  // region is just an alignment column.
  maxWidth: "min(420px, calc(100vw - 32px))",
};

const TOAST_BASE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  width: "min(420px, calc(100vw - 32px))",
  padding: "var(--space-3) var(--space-4)",
  background: "var(--paper)",
  border: "1px solid var(--paper-3)",
  borderRadius: "var(--radius-m)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  lineHeight: "var(--lh-small)",
  color: "var(--ink)",
  pointerEvents: "auto",
};

const TOAST_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--space-3)",
};

const TONE_TAG_STYLE: CSSProperties = {
  flex: "0 0 auto",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  paddingTop: "2px",
};

const TOAST_MESSAGE_STYLE: CSSProperties = {
  flex: "1 1 auto",
  color: "var(--ink)",
  // Preserve operator-supplied line breaks in the message half;
  // details get a full <pre>.
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const DISMISS_BTN_STYLE: CSSProperties = {
  flex: "0 0 auto",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-body)",
  lineHeight: 1,
  color: "var(--ink-3)",
  background: "transparent",
  border: "none",
  borderRadius: "var(--radius-s)",
  cursor: "pointer",
  padding: "2px 6px",
};

const DETAILS_WRAP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const DETAILS_TOGGLE_STYLE: CSSProperties = {
  alignSelf: "flex-start",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--ink-3)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: 0,
  textDecoration: "underline",
};

const DETAILS_PRE_STYLE: CSSProperties = {
  margin: 0,
  padding: "var(--space-2)",
  background: "var(--paper-2)",
  border: "1px solid var(--paper-3)",
  borderRadius: "var(--radius-s)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  lineHeight: "var(--lh-micro)",
  color: "var(--ink-2)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 200,
  overflowY: "auto",
};

const TONE_STYLES: Record<
  Tone,
  { readonly accent: string; readonly label: string }
> = {
  success: { accent: "var(--healthy)", label: "OK" },
  advisory: { accent: "var(--advisory)", label: "ADVISORY" },
  alert: { accent: "var(--alert)", label: "ALERT" },
};

// Re-export for tests / consumers that need to assert against
// the canonical tone names.
export type { Tone, ToastOpts, ToastInput, ToastApi };
