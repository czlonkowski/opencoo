/**
 * Cross-route visual-consistency snapshot — PR-C7 (wave-16,
 * phase-a appendix #16).
 *
 * Pins the load-bearing structural contracts that connect every
 * route in the management console. Each invariant lives as its own
 * `it(...)` block so a future regression surfaces with a specific
 * fail message — not a generic "snapshot diverged".
 *
 * Per-route DOM invariants (asserted on each of the eleven routes
 * under jsdom):
 *   1. Exactly one `<h1>` with `id="opencoo-page-h1"`        (A2)
 *   2. Exactly one `<main>` with the matching aria-labelledby  (A2)
 *
 * Static source-file invariants (asserted once across the whole
 * `packages/ui/src/` tree). These are static because jsdom's CSS
 * parser canonicalises `style="color: #aabbcc"` to
 * `style="color: rgb(170, 187, 204);"` BEFORE the DOM is queryable
 * — so a runtime DOM walk silently passes through any hex literal
 * the JSX wrote. The static scan reads the verbatim source bytes
 * the W11 audit fence is meant to police:
 *   3. No hex literals (`#rgb`/`#rrggbb`/`#rrggbbaa`) anywhere
 *      under `src/`. Catches inline `style={{}}` literals AND
 *      shared `CSSProperties` consts AND string-template CSS.   (W11)
 *   4. No `dangerouslySetInnerHTML` JSX prop anywhere under `src/`.
 *      THREAT-MODEL §3.13 invariant.                          (PIN)
 *
 * Cross-route invariants:
 *   5. `<Display>` (editorial-serif lede) appears in EXACTLY
 *      three routes: Reports, Prompts, Domains.              (C4)
 *   6. Sidebar renders the canonical Tab labels in both `en`
 *      and `pl` locales. The count assertion derives from the
 *      `Tab` union — currently eleven — so a future tab
 *      addition surfaces here automatically.
 *
 * The walk is structural — vitest + jsdom + filesystem grep — not
 * pixel-diff. A Playwright + visual-regression suite is out of
 * scope per the wave-16 plan-appendix §"Out of scope".
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import i18n from "i18next";

import { Sidebar } from "../src/components/Chrome.js";
import type { Tab } from "../src/types.js";
import { ALL_TABS, renderRoute } from "./test-utils/render-route.js";

/* ────────────────────────────────────────────────────────── */
/* Fixtures                                                   */
/* ────────────────────────────────────────────────────────── */

/** Stub the SSE client the Activity route opens on mount. The
 *  visual-consistency suite never asserts streaming behavior;
 *  short-circuiting `openSseClient` avoids a hung test process. */
vi.mock("../src/lib/sse.js", () => ({
  openSseClient: () => ({
    readyState: "open" as const,
    on: () => () => {},
    close: () => {},
  }),
}));

/** Empty-but-well-shaped 200 response for every admin URL the
 *  routes touch on first render. Mirrors the shape h1-coverage.test
 *  already uses — the visual-consistency contracts don't depend on
 *  loaded data, so empty rows / counts are enough to mount without
 *  crashing. The reports diagnostic-precondition shape is exercised
 *  in detail because Reports.tsx reads several fields synchronously
 *  on first render. */
function makeNoopFetch(): typeof fetch {
  return ((input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : (input as Request).url;
    let body: unknown = { rows: [], total: 0 };
    if (url.includes("/pipelines")) body = { pipelines: [] };
    else if (url.includes("/agent-runs")) body = { rows: [], total: 0 };
    else if (url.includes("/scheduler")) body = { schedules: [] };
    else if (url.includes("/heartbeat/preconditions")) {
      body = {
        heartbeatInstanceCount: 1,
        enabledHeartbeatInstanceCount: 1,
        instancesWithoutOutputChannels: 0,
        mostRecentRun: {
          startedAt: new Date().toISOString(),
          status: "success",
          outputIsNull: false,
          instanceName: "heartbeat-test",
        },
        mostRecentDispatchedAt: new Date().toISOString(),
      };
    } else if (url.includes("/heartbeat")) body = { reports: [] };
    else if (url.includes("/redaction-events")) body = { rows: [] };
    else if (url.includes("/audit-log")) body = { rows: [] };
    else if (url.includes("/cost-summary")) body = { rows: [], totals: {} };
    else if (url.includes("/domains")) body = { rows: [] };
    else if (url.includes("/source-bindings")) body = { rows: [] };
    else if (url.includes("/agent-instances")) body = { rows: [] };
    else if (url.includes("/output-channels")) body = { rows: [] };
    else if (url.includes("/prompts")) body = { rows: [] };
    else if (url.includes("/adapters")) body = { adapters: [] };
    else if (url.includes("/lint-findings")) body = { runs: [] };
    else if (url.includes("/automation-candidates")) body = { rows: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  // `LlmPolicy` reads `globalThis.fetch` (no fetchImpl seam); stub
  // it globally so every route can mount under the same shell.
  vi.stubGlobal("fetch", makeNoopFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
});

/* ────────────────────────────────────────────────────────── */
/* Static source-file scans (W11 + THREAT-MODEL fences)        */
/* ────────────────────────────────────────────────────────── */

/** Hex color literal: `#rgb`, `#rrggbb`, `#rrggbbaa`, etc. The
 *  `\b` boundary plus the bounded `{3,8}` quantifier reject
 *  fragment identifiers / hashed CSS class names with mixed
 *  alphabetic chars (e.g. `#opencoo-page-h1` — the dash breaks
 *  the word boundary; the letters past `f` fall outside the
 *  character class). */
const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/g;

/** Root of the UI source tree this test sweeps. Resolved at module
 *  load time so the test still works when vitest is invoked from
 *  the repo root, the package root, or anywhere in between — the
 *  `import.meta.url` anchor points at THIS file, regardless of
 *  process cwd. `fileURLToPath` is the canonical Node way to get
 *  a real filesystem path from an ESM module URL (the older
 *  `import.meta.url.pathname` route is documented as un-portable;
 *  on this codebase it returned the empty path `/src`). */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_ROOT = resolve(__dirname, "..", "src");

/** Recursive walk yielding every `.ts` / `.tsx` file under a
 *  directory. Skips `node_modules` defensively — `src/` doesn't
 *  carry one, but a future re-org might.
 *
 *  Synchronous on purpose: the tree is ~100 files and vitest's
 *  worker pool isn't worth the I/O contention for this many
 *  shallow reads. */
function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const s = statSync(full);
    if (s.isDirectory()) {
      yield* walkTs(full);
    } else if (
      s.isFile() &&
      (entry.endsWith(".ts") || entry.endsWith(".tsx"))
    ) {
      yield full;
    }
  }
}

interface StyleHexHit {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly match: string;
}

/** Walks every `.ts`/`.tsx` source file under `src/` looking for
 *  hex color literals. After `stripComments` runs, any remaining
 *  `#rgb`/`#rrggbb`/`#rrggbbaa` byte sequence is either:
 *
 *    - an inline-style hex literal (`style={{ color: "#aabbcc" }}`) —
 *      a W11 audit-fence violation; or
 *    - a hex inside a typed CSSProperties object (the TOGGLE_ROW_STYLE
 *      pattern) — also a violation; or
 *    - a hex inside any other string/template-literal value that's
 *      almost certainly downstream CSS — still a violation under
 *      the design-system "no hex literals anywhere" rule.
 *
 *  The previous shape of this scan filtered to "only inside
 *  `style={{ ... }}`" but that missed shared `const STYLE: CSSProperties`
 *  objects + string-template CSS strings the route bodies use. The
 *  W11 audit fence's intent is broader than that — any hex byte
 *  pattern under `src/` is a regression. */
function findInlineStyleHexInSources(): readonly StyleHexHit[] {
  const hits: StyleHexHit[] = [];
  for (const file of walkTs(SRC_ROOT)) {
    // Strip all comments first — line counts are preserved (every
    // newline inside a stripped /* ... */ block survives as a bare
    // newline) so diagnostic line numbers downstream still match
    // the operator's view of the file.
    const src = stripComments(readFileSync(file, "utf8"));
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // `matchAll` on a /g regex; each iteration yields one hit.
      for (const m of line.matchAll(HEX_COLOR_RE)) {
        hits.push({
          file: relative(SRC_ROOT, file),
          line: i + 1,
          snippet: line.trim().slice(0, 120),
          match: m[0],
        });
      }
    }
  }
  return hits;
}

interface DangerousHit {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/** Strip JavaScript line + block comments from a source string,
 *  preserving line numbers (newlines inside `/* ... *\/` stay so
 *  diagnostic line numbers downstream still match the original
 *  file). Used by both source-scan helpers — comments routinely
 *  mention the very tokens we're trying to ban ("we never use
 *  `dangerouslySetInnerHTML`", "no inline `#hex` colors"). The
 *  strip is conservative: it walks character-by-character with a
 *  tiny state machine so string-literal contents are not mistaken
 *  for the start of a comment. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  // States: 0 = code, 1 = single-line comment, 2 = block comment,
  // 3 = single-quoted string, 4 = double-quoted string, 5 = template
  let state = 0;
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (state === 0) {
      if (c === "/" && c2 === "/") {
        state = 1;
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        state = 2;
        i += 2;
        continue;
      }
      if (c === "'") {
        state = 3;
        out += c;
        i++;
        continue;
      }
      if (c === '"') {
        state = 4;
        out += c;
        i++;
        continue;
      }
      if (c === "`") {
        state = 5;
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
    } else if (state === 1) {
      // Single-line comment — preserve newlines for line numbers.
      if (c === "\n") {
        out += "\n";
        state = 0;
      }
      i++;
    } else if (state === 2) {
      // Block comment — preserve newlines.
      if (c === "\n") out += "\n";
      if (c === "*" && c2 === "/") {
        state = 0;
        i += 2;
        continue;
      }
      i++;
    } else if (state === 3) {
      out += c;
      if (c === "\\" && c2 !== undefined) {
        out += c2;
        i += 2;
        continue;
      }
      if (c === "'") state = 0;
      i++;
    } else if (state === 4) {
      out += c;
      if (c === "\\" && c2 !== undefined) {
        out += c2;
        i += 2;
        continue;
      }
      if (c === '"') state = 0;
      i++;
    } else if (state === 5) {
      out += c;
      if (c === "\\" && c2 !== undefined) {
        out += c2;
        i += 2;
        continue;
      }
      if (c === "`") state = 0;
      i++;
    }
  }
  return out;
}

/** Source-level scan for `dangerouslySetInnerHTML`. THREAT-MODEL
 *  §3.13 says: never. The match is a bare substring — the prop
 *  name is distinctive enough that no other token can collide.
 *  Strips comments first so JSDoc / inline notes that mention the
 *  prop (e.g. "we never use dangerouslySetInnerHTML") don't false-
 *  positive. */
function findDangerousInnerHtmlInSources(): readonly DangerousHit[] {
  const hits: DangerousHit[] = [];
  for (const file of walkTs(SRC_ROOT)) {
    const src = stripComments(readFileSync(file, "utf8"));
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes("dangerouslySetInnerHTML")) {
        hits.push({
          file: relative(SRC_ROOT, file),
          line: i + 1,
          snippet: lines[i]!.trim().slice(0, 120),
        });
      }
    }
  }
  return hits;
}

// Lazy-evaluate the source scans once at suite setup; each test
// block re-reads the result so failures stay specific without
// re-running the disk walk eleven times.
const STYLE_HEX_HITS = findInlineStyleHexInSources();
const DANGEROUS_HTML_HITS = findDangerousInnerHtmlInSources();

/* ────────────────────────────────────────────────────────── */
/* Per-route invariants                                       */
/* ────────────────────────────────────────────────────────── */

describe("Cross-route visual consistency (PR-C7, wave-16)", () => {
  // The Tab union is currently eleven entries; the canonical
  // walk-list assertion guards against silent drift in either
  // direction.
  it("ALL_TABS mirrors the Tab union (11 entries)", () => {
    expect(ALL_TABS.length).toBe(11);
  });

  describe("per-route landmark + h1 contract (DOM walk)", () => {
    for (const tab of ALL_TABS) {
      describe(`route=${tab}`, () => {
        it("renders exactly one <h1 id='opencoo-page-h1'>", () => {
          const { container } = renderRoute(tab, {
            fetchImpl: makeNoopFetch(),
          });
          const h1s = container.querySelectorAll("h1");
          expect(h1s.length).toBe(1);
          expect(h1s[0]!.id).toBe("opencoo-page-h1");
        });

        it("mounts exactly one <main aria-labelledby='opencoo-page-h1'>", () => {
          const { container } = renderRoute(tab, {
            fetchImpl: makeNoopFetch(),
          });
          const mains = container.querySelectorAll("main");
          expect(mains.length).toBe(1);
          expect(mains[0]!.getAttribute("aria-labelledby")).toBe(
            "opencoo-page-h1",
          );
        });
      });
    }
  });

  describe("static source fences (filesystem grep)", () => {
    it("no hex-color literals anywhere under src/ (W11 audit fence)", () => {
      // jsdom canonicalises `style="color: #aabbcc"` to
      // `style="color: rgb(170, 187, 204);"` BEFORE the DOM is
      // queryable, so a runtime walk silently passes through
      // hex literals. The static source scan reads the verbatim
      // bytes of every `.ts`/`.tsx` file in `src/` (after
      // stripping comments — references to PRs like "#131" must
      // not false-positive) and flags every hex byte sequence.
      //
      // The design system permits color values only via CSS vars
      // (`var(--ink)` / `var(--paper)` etc); any inline hex is
      // a regression regardless of whether it lands in a JSX
      // `style={{}}` literal, a shared `CSSProperties` const,
      // or a CSS-in-JS string template.
      if (STYLE_HEX_HITS.length > 0) {
        const summary = STYLE_HEX_HITS.slice(0, 5)
          .map(
            (h) =>
              `${h.file}:${h.line} ← ${h.match} in: ${h.snippet}`,
          )
          .join("\n  ");
        throw new Error(
          `Found ${STYLE_HEX_HITS.length} hex color literal(s) under src/:\n  ${summary}`,
        );
      }
      expect(STYLE_HEX_HITS).toEqual([]);
    });

    it("no `dangerouslySetInnerHTML` anywhere under src/ (THREAT-MODEL §3.13)", () => {
      if (DANGEROUS_HTML_HITS.length > 0) {
        const summary = DANGEROUS_HTML_HITS.slice(0, 5)
          .map(
            (h) =>
              `${h.file}:${h.line} ← ${h.snippet}`,
          )
          .join("\n  ");
        throw new Error(
          `Found ${DANGEROUS_HTML_HITS.length} dangerouslySetInnerHTML occurrence(s):\n  ${summary}`,
        );
      }
      expect(DANGEROUS_HTML_HITS).toEqual([]);
    });
  });

  /* ────────────────────────────────────────────────────────── */
  /* Cross-route invariants                                     */
  /* ────────────────────────────────────────────────────────── */

  describe("cross-route invariants", () => {
    it("`<Display>` renders in EXACTLY 3 routes (Reports, Prompts, Domains)", () => {
      // The editorial-serif lede class is `.t-lede` (level=2|3).
      // `.t-display` (level=1) is reserved for a future docs site
      // and must not appear in any v0.1 management-console route.
      const lede: Tab[] = [];
      const displayLevel1Counts: Partial<Record<Tab, number>> = {};
      for (const tab of ALL_TABS) {
        const { container } = renderRoute(tab, {
          fetchImpl: makeNoopFetch(),
        });
        const ledeNodes = container.querySelectorAll(".t-lede").length;
        const displayLevel1Nodes =
          container.querySelectorAll(".t-display").length;
        if (ledeNodes > 0) lede.push(tab);
        if (displayLevel1Nodes > 0) {
          displayLevel1Counts[tab] = displayLevel1Nodes;
        }
        cleanup();
      }
      // The C4 contract: Reports + Prompts + Domains carry the
      // editorial lede; nobody else does.
      expect(lede.sort()).toEqual(["domains", "prompts", "reports"]);
      // `<Display level={1}>` (`.t-display`) is reserved for a
      // future docs site. Any in-console occurrence is a violation.
      expect(displayLevel1Counts).toEqual({});
    });

    it("sidebar renders every Tab label in en (11 entries)", async () => {
      await i18n.changeLanguage("en");
      const { container } = render(
        <Sidebar tab="domains" setTab={(): void => undefined} />,
      );
      const buttons = container.querySelectorAll("button");
      // The Sidebar emits one <button> per Tab; the canonical
      // count is ALL_TABS.length (currently 11).
      expect(buttons.length).toBe(ALL_TABS.length);
      // Every button must render a non-empty text label so an
      // operator can identify the destination tab.
      buttons.forEach((b) => {
        expect((b.textContent ?? "").trim().length).toBeGreaterThan(0);
      });
    });

    it("sidebar renders every Tab label in pl (translated, distinct from en)", async () => {
      // Render en first to capture the canonical labels.
      await i18n.changeLanguage("en");
      const enRender = render(
        <Sidebar tab="domains" setTab={(): void => undefined} />,
      );
      const enLabels = Array.from(
        enRender.container.querySelectorAll("button"),
      ).map((b) => (b.textContent ?? "").trim());
      enRender.unmount();

      // Now flip to pl and capture the Polish labels.
      await i18n.changeLanguage("pl");
      const plRender = render(
        <Sidebar tab="domains" setTab={(): void => undefined} />,
      );
      const plLabels = Array.from(
        plRender.container.querySelectorAll("button"),
      ).map((b) => (b.textContent ?? "").trim());
      plRender.unmount();

      // Sanity: both locales render the same number of buttons.
      expect(plLabels.length).toBe(enLabels.length);
      expect(plLabels.length).toBe(ALL_TABS.length);

      // Every Polish label is non-empty…
      plLabels.forEach((label) => {
        expect(label.length).toBeGreaterThan(0);
      });

      // …and at least one differs from its English counterpart
      // (proving the locale switch actually re-resolved keys). The
      // assertion is "at least one differs" rather than "all
      // differ" because a few keys collide between locales by
      // design (proper nouns, identifiers) — e.g. neither locale
      // translates "llm" away from "llm".
      const anyDifferent = enLabels.some(
        (en, idx) => en.toLowerCase() !== plLabels[idx]!.toLowerCase(),
      );
      expect(anyDifferent).toBe(true);

      // Restore en for downstream tests that depend on the
      // beforeEach env default (i18n is module-singleton state).
      await i18n.changeLanguage("en");
    });
  });
});
