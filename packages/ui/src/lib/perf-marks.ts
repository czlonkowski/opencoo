/**
 * Perf instrumentation helpers — PR-B8 (wave-16, phase-a appendix
 * #16). Thin wrappers around `performance.mark` /
 * `performance.measure` so the wave-end Lighthouse run can read
 * structured route-navigation timings without each consumer
 * re-deriving the mark name.
 *
 * Naming schema (one place, here):
 *
 *   route:<tab>:click         — sidebar / palette dispatched a nav
 *   route:<tab>:import-start  — React.lazy chunk started loading
 *   route:<tab>:import-end    — chunk resolved, component mountable
 *   route:<tab>:fetch-start   — route's data fetch begins
 *   route:<tab>:fetch-end     — route's data fetch resolves
 *   route:<tab>:nav           — measure: click → fetch-end
 *
 * Every mark / measure ALSO appends a structured entry to
 * `window.opencoo_perf` so a dev-only PerfPanel and an external
 * Lighthouse runner (`page.evaluate(() => window.opencoo_perf)`)
 * both read from the same source. The browser already maintains
 * a buffer for `performance.getEntries()`, but Safari truncates
 * after 250 entries and the buffer is shared with other libs;
 * the side-channel keeps opencoo's entries isolated.
 *
 * Lib is intentionally tiny — it owns naming, ordering and the
 * side-channel array. Nothing else.
 */

/**
 * Public entry shape on `window.opencoo_perf`. `time` is a
 * `performance.now()` reading (DOMHighResTimeStamp, ms since
 * navigationStart). `duration` is only present on measure entries.
 */
export interface OpencooPerfEntry {
  readonly name: string;
  readonly type: "mark" | "measure";
  readonly time: number;
  readonly duration?: number;
}

declare global {
  interface Window {
    /** Side-channel for opencoo's perf entries. Populated lazily
     *  on first mark. External readers (PerfPanel, Lighthouse
     *  runners) must tolerate `undefined` until the first call. */
    opencoo_perf?: OpencooPerfEntry[];
  }
}

/**
 * Append a single entry to `window.opencoo_perf`, creating the
 * array on first use. Exported so consumers that emit custom
 * non-route marks (e.g. agent-runs SSE) can share the channel
 * without re-importing the array.
 */
export function pushPerfEntry(entry: OpencooPerfEntry): void {
  if (typeof window === "undefined") return;
  if (!Array.isArray(window.opencoo_perf)) {
    window.opencoo_perf = [];
  }
  window.opencoo_perf.push(entry);
}

function safeMark(name: string): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") {
    return;
  }
  try {
    performance.mark(name);
  } catch {
    // performance.mark can throw on duplicate names in some
    // engines under strict modes; swallowing keeps the lib
    // side-effect-only.
    return;
  }
  pushPerfEntry({ name, type: "mark", time: performance.now() });
}

/** Mark the moment a sidebar / palette click dispatches a nav. */
export function markRouteClick(tab: string): void {
  safeMark(`route:${tab}:click`);
}

/** Mark the start of the `React.lazy` chunk load for `tab`. */
export function markRouteImportStart(tab: string): void {
  safeMark(`route:${tab}:import-start`);
}

/** Mark the moment the lazy chunk has resolved. */
export function markRouteImportEnd(tab: string): void {
  safeMark(`route:${tab}:import-end`);
}

/** Mark the start of the route's data fetch. */
export function markRouteFetchStart(tab: string): void {
  safeMark(`route:${tab}:fetch-start`);
}

/** Mark the resolution of the route's data fetch. */
export function markRouteFetchEnd(tab: string): void {
  safeMark(`route:${tab}:fetch-end`);
}

/**
 * Bracket-measure: click → fetch-end. Swallows the DOMException
 * that fires if the bracket marks aren't present (operator bailed
 * mid-nav). The measure also lands on `window.opencoo_perf` for
 * the dev panel.
 */
export function measureRouteNav(tab: string): void {
  if (
    typeof performance === "undefined" ||
    typeof performance.measure !== "function"
  ) {
    return;
  }
  const startName = `route:${tab}:click`;
  const endName = `route:${tab}:fetch-end`;
  const measureName = `route:${tab}:nav`;
  let duration: number | undefined;
  try {
    const m = performance.measure(measureName, startName, endName);
    // Older browsers (and jsdom) return `undefined` from measure
    // even on success; pull the duration off the buffer instead.
    if (m !== undefined && typeof m.duration === "number") {
      duration = m.duration;
    } else {
      const entries = performance.getEntriesByName(measureName, "measure");
      const last = entries[entries.length - 1];
      if (last !== undefined) duration = last.duration;
    }
  } catch {
    // Bracket marks missing — operator bailed mid-nav.
    return;
  }
  pushPerfEntry({
    name: measureName,
    type: "measure",
    time: performance.now(),
    ...(duration !== undefined ? { duration } : {}),
  });
}
