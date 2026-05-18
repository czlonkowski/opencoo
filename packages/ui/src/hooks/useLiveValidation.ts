/**
 * useLiveValidation — real-time form validation (wave-16 PR-B4).
 *
 * Two-tier validation per field:
 *   - Sync validator runs on every value change. Returns the
 *     error message synchronously (or null on pass). A sync
 *     failure short-circuits the async leg — we don't probe the
 *     server with a value the client already knows is wrong.
 *   - Async validator is debounced 250ms after the last keystroke;
 *     new keystrokes cancel the in-flight call via AbortController.
 *     The hook ignores resolutions whose abort signal fired before
 *     the promise settled, so a slow first-call response can't
 *     overwrite a faster second-call result.
 *
 * Field state machine: idle → validating → valid|invalid.
 *   - idle: the field hasn't been touched yet (initial mount, OR
 *     the value is empty — async probes skip empty input).
 *   - validating: a value changed and the debounced async call is
 *     either pending or in flight.
 *   - valid: every active validator returned null.
 *   - invalid: a validator returned a non-empty error message.
 *
 * The hook reads `values` as a controlled bag — callers using
 * uncontrolled inputs (the PR-Z9 pattern in NewDomainModal et al.)
 * must mirror the live DOM value into a small piece of React
 * state so the hook can observe it. The Z9 ref pattern survives:
 * the operator's DOM input is still uncontrolled, the React
 * state used here is a shadow read on input events.
 */
import { useEffect, useRef, useState } from "react";

export const LIVE_VALIDATION_DEBOUNCE_MS = 250;

export type ValidationStatus = "idle" | "validating" | "valid" | "invalid";

export interface ValidationState {
  readonly status: ValidationStatus;
  readonly message: string | null;
}

export type SyncValidator<T extends Record<string, string>> = (
  value: string,
  allValues: T,
) => string | null;

export type AsyncValidator<T extends Record<string, string>> = (
  value: string,
  allValues: T,
  signal: AbortSignal,
) => Promise<string | null>;

/** Per-field validator entry. Either a bare sync function OR an
 *  object that splits sync + async legs. */
export type ValidatorEntry<T extends Record<string, string>> =
  | SyncValidator<T>
  | {
      readonly sync?: SyncValidator<T>;
      readonly async?: AsyncValidator<T>;
    };

export type ValidatorMap<T extends Record<string, string>> = {
  readonly [K in keyof T]?: ValidatorEntry<T>;
};

export type ValidationStateMap<T extends Record<string, string>> = {
  readonly [K in keyof T]: ValidationState;
};

const IDLE: ValidationState = { status: "idle", message: null };

interface InFlight {
  readonly controller: AbortController;
  readonly value: string;
  readonly token: number;
}

function normalizeEntry<T extends Record<string, string>>(
  entry: ValidatorEntry<T> | undefined,
): { sync?: SyncValidator<T>; async?: AsyncValidator<T> } {
  if (entry === undefined) return {};
  if (typeof entry === "function") return { sync: entry };
  const result: { sync?: SyncValidator<T>; async?: AsyncValidator<T> } = {};
  if (entry.sync !== undefined) result.sync = entry.sync;
  if (entry.async !== undefined) result.async = entry.async;
  return result;
}

export function useLiveValidation<T extends Record<string, string>>(
  values: T,
  validators: ValidatorMap<T>,
): ValidationStateMap<T> {
  // Read the live validator keys on every render. Callers may pass
  // a dynamic map (e.g. NewSourceBindingModal's binding-config
  // schema only resolves after `/api/admin/adapters` lands). The
  // hook needs to react when new fields appear, not freeze the
  // shape at mount time.
  const fieldNames = Object.keys(validators) as Array<keyof T & string>;

  // Validators are stored on a ref so the effect (which only
  // depends on `values` + the field-name set) always reads the
  // freshest closures. Callers commonly recreate the validator
  // map every render — they close over `t` (i18n) or component
  // props, and a stale closure here would surface English error
  // copy on locale-switched modals (or worse, stale comparisons
  // against props that no longer apply). Updating the ref on
  // every render is cheap; the effect runs only on value changes.
  const validatorsRef = useRef<ValidatorMap<T>>(validators);
  validatorsRef.current = validators;

  const [state, setState] = useState<Record<string, ValidationState>>({});

  // Refs that survive renders without triggering re-runs.
  const lastValuesRef = useRef<T>(values);
  const inFlightRef = useRef<Record<string, InFlight | undefined>>({});
  const tokenRef = useRef<number>(0);
  const debounceTimersRef = useRef<
    Record<string, ReturnType<typeof setTimeout> | undefined>
  >({});

  useEffect(() => {
    const prev = lastValuesRef.current;
    const next = values;
    lastValuesRef.current = next;

    const updates: Record<string, ValidationState> = {};
    let dirty = false;

    for (const name of fieldNames) {
      const value = next[name] ?? "";
      const prevValue = prev[name] ?? "";
      // Only re-validate when the value actually changed. `state[name]`
      // may be undefined for fields the hook hasn't observed yet
      // (dynamic validator maps surface after async fetches) — we
      // treat that as "idle, never seen" and skip when value hasn't
      // changed either.
      if (value === prevValue) continue;

      const entry = normalizeEntry<T>(validatorsRef.current[name]);

      // Sync first — short-circuits async on format failure.
      if (entry.sync !== undefined) {
        const syncResult = entry.sync(value, next);
        if (syncResult !== null) {
          updates[name] = { status: "invalid", message: syncResult };
          dirty = true;
          // Cancel any in-flight async for this field.
          const inFlight = inFlightRef.current[name];
          if (inFlight !== undefined) {
            inFlight.controller.abort();
            inFlightRef.current[name] = undefined;
          }
          const pending = debounceTimersRef.current[name];
          if (pending !== undefined) {
            clearTimeout(pending);
            debounceTimersRef.current[name] = undefined;
          }
          continue;
        }
      }

      // Async leg, if any. Empty values short-circuit to idle —
      // probing the server with an empty string would surface
      // misleading "valid" or "invalid" markers before the operator
      // has typed anything.
      if (entry.async !== undefined) {
        if (value.length === 0) {
          updates[name] = IDLE;
          dirty = true;
          const inFlight = inFlightRef.current[name];
          if (inFlight !== undefined) {
            inFlight.controller.abort();
            inFlightRef.current[name] = undefined;
          }
          const pending = debounceTimersRef.current[name];
          if (pending !== undefined) {
            clearTimeout(pending);
            debounceTimersRef.current[name] = undefined;
          }
          continue;
        }
        updates[name] = { status: "validating", message: null };
        dirty = true;
        // Cancel any in-flight async for this field — the operator
        // kept typing.
        const inFlight = inFlightRef.current[name];
        if (inFlight !== undefined) {
          inFlight.controller.abort();
          inFlightRef.current[name] = undefined;
        }
        const pending = debounceTimersRef.current[name];
        if (pending !== undefined) clearTimeout(pending);

        // Debounce.
        debounceTimersRef.current[name] = setTimeout(() => {
          const controller = new AbortController();
          const token = tokenRef.current + 1;
          tokenRef.current = token;
          const handle: InFlight = { controller, value, token };
          inFlightRef.current[name] = handle;
          const asyncFn = entry.async;
          if (asyncFn === undefined) return;
          asyncFn(value, lastValuesRef.current, controller.signal).then(
            (result) => {
              // Stale-call guard: if a newer token claimed this
              // field OR the controller aborted before we landed,
              // drop the result.
              const current = inFlightRef.current[name];
              if (current?.token !== token) return;
              if (controller.signal.aborted) return;
              inFlightRef.current[name] = undefined;
              setState((prevState) => ({
                ...prevState,
                [name]:
                  result === null
                    ? { status: "valid", message: null }
                    : { status: "invalid", message: result },
              }));
            },
            () => {
              // Aborted or threw — drop the result if it was the
              // current call. (For a non-current call, we already
              // moved on; nothing to do.)
              const current = inFlightRef.current[name];
              if (current?.token === token) {
                inFlightRef.current[name] = undefined;
              }
            },
          );
        }, LIVE_VALIDATION_DEBOUNCE_MS);
        continue;
      }

      // No async leg → sync-only field.
      if (entry.sync !== undefined) {
        updates[name] = { status: "valid", message: null };
        dirty = true;
      }
    }

    if (dirty) {
      setState((prevState) => {
        const merged = { ...prevState };
        for (const [k, v] of Object.entries(updates)) merged[k] = v;
        return merged;
      });
    }
    // The effect re-runs when `values` change AND when the set of
    // active field names changes (dynamic validator maps surface
    // after async fetches). `fieldNames.join(',')` is a cheap
    // stable signature; we deliberately don't depend on the
    // `validators` object identity (callers commonly recreate it
    // every render).
  }, [values, fieldNames.join(",")]);

  // Clean up on unmount.
  useEffect(() => {
    return (): void => {
      for (const t of Object.values(debounceTimersRef.current)) {
        if (t !== undefined) clearTimeout(t);
      }
      for (const handle of Object.values(inFlightRef.current)) {
        if (handle !== undefined) handle.controller.abort();
      }
    };
  }, []);

  // Build the return map — missing fields default to IDLE so the
  // accessor never crashes on a key the caller asks about before
  // it's been observed (e.g. a config-step field that the operator
  // hasn't touched).
  const out: Record<string, ValidationState> = {};
  for (const name of fieldNames) {
    out[name] = state[name] ?? IDLE;
  }
  return out as ValidationStateMap<T>;
}
