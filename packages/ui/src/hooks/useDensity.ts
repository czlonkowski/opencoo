/**
 * `useDensity` — global density preference for the management UI
 * (PR-C6, phase-a appendix #16 wave-16).
 *
 * Per-device chrome preference, NOT per-account — density lives in
 * `localStorage.opencoo_density` only. No DB column, no admin
 * route. Mirrors how IDE themes work: an operator who picks
 * `compact` on their workstation keeps `comfortable` on a kiosk or
 * a second machine until they flip there too.
 *
 * The hook is the only writer of both surfaces:
 *   - `localStorage.opencoo_density` is the in-session SoT (read
 *     on next mount).
 *   - `<body data-density="compact|comfortable">` is what CSS reads
 *     to scope the density-aware variables in `colors_and_type.css`.
 *
 * The body attribute is also set on mount with the current value so
 * the CSS variant binds even if the operator never opens the toggle
 * (a fresh load with no prior preference still gets the explicit
 * `data-density="comfortable"` so `:root` defaults and the explicit
 * attribute selector behave the same way).
 */
import { useCallback, useEffect, useState } from "react";

export type Density = "comfortable" | "compact";

const STORAGE_KEY = "opencoo_density";
const BODY_ATTR = "data-density";

function readStoredDensity(): Density {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "comfortable" || raw === "compact") return raw;
  } catch {
    // localStorage can throw under quota / privacy modes — fall
    // through to the default; the toggle still works in-session.
  }
  return "comfortable";
}

function writeBodyAttr(value: Density): void {
  if (typeof document === "undefined") return;
  document.body.setAttribute(BODY_ATTR, value);
}

export interface UseDensityReturn {
  readonly density: Density;
  readonly setDensity: (next: Density) => void;
}

export function useDensity(): UseDensityReturn {
  // Lazy initializer so the localStorage read runs once per mount
  // (not every render).
  const [density, setDensityState] = useState<Density>(readStoredDensity);

  // Mirror the value onto <body> as soon as the hook mounts. This
  // is intentionally an effect — server-render envs won't have a
  // `document.body` at first paint, and useState's initializer
  // can't touch it cleanly across SSR/SPA paths.
  useEffect(() => {
    writeBodyAttr(density);
  }, [density]);

  const setDensity = useCallback((next: Density): void => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore — the in-session state below still flips.
    }
    writeBodyAttr(next);
    setDensityState(next);
  }, []);

  return { density, setDensity };
}
