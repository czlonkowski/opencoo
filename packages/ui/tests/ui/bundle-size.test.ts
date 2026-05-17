/**
 * @vitest-environment node
 *
 * Bundle-size fence — PR-B2 (wave-16, phase-a appendix #16).
 *
 * Pins the budget the user-facing perceived-latency story
 * depends on:
 *
 *   1. **Entry chunk ≤ 200 KB gzipped.** The first chunk
 *      shipped to a cold operator must include only the
 *      React runtime + i18n bootstrap + Chrome shell + the
 *      route-skeleton primitives. Each route's body lives
 *      behind a `React.lazy` boundary, so they MUST NOT
 *      land in the entry chunk. Measure via Node's built-in
 *      `zlib.gzipSync` — adding a `gzip-size` dep just for
 *      this fence is over-engineering.
 *
 *   2. **At least 7 route chunks.** The Vite default chunker
 *      emits one chunk per dynamic `import()` boundary, so
 *      `lazy(() => import('./routes/X'))` produces a separate
 *      file in `dist/assets/`. We assert ≥7 (we have 11
 *      routes but a few may co-bundle if Vite detects a
 *      shared graph; 7 is a defensive floor — the PR docs
 *      record the actual count).
 *
 * Operational notes:
 *   - The build is the upstream concern: this test does NOT
 *     run `pnpm build` itself (Vite takes ~6 s on a warm
 *     cache, ~25 s cold — too slow for unit-test budgets).
 *     If `dist/ui/` is missing, the test SKIPS with a
 *     descriptive message so contributors know to run
 *     `pnpm --filter @opencoo/ui build` first. CI runs the
 *     build step in the `ci.yml` matrix before the test
 *     pass, so the skip branch only triggers locally.
 *
 *   - The "entry chunk" is the JS chunk referenced by
 *     `index.html`'s `<script type="module" src="…">` tag.
 *     We resolve it by parsing `dist/ui/index.html` rather
 *     than by name pattern — Vite hashes filenames so
 *     `index-XXX.js` patterns drift across builds.
 *
 *   - Vite emits the build into
 *     `packages/engine-self-operating/dist/ui/` per
 *     `packages/ui/vite.config.ts:24-26` (so the
 *     engine-self-operating `static-ui.ts` middleware can
 *     serve it). The bundle test resolves this path
 *     relative to the workspace root.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

const ENTRY_CHUNK_BUDGET_KB = 200;
const MIN_ROUTE_CHUNKS = 7;

// `engine-self-operating/dist/ui/` is the Vite outDir per the
// UI vite.config.ts. Path resolution is anchored at the
// monorepo root (three levels up from this test file).
const DIST_ROOT = resolve(
  __dirname,
  "../../../engine-self-operating/dist/ui",
);
const DIST_ASSETS = resolve(DIST_ROOT, "assets");
const DIST_INDEX_HTML = resolve(DIST_ROOT, "index.html");

function distMissing(): boolean {
  return !existsSync(DIST_ROOT) || !existsSync(DIST_INDEX_HTML);
}

/** Parse `index.html` and pull the entry `<script src>` path. */
function resolveEntryChunkPath(): string {
  const html = readFileSync(DIST_INDEX_HTML, "utf-8");
  // Vite's emitted script tag looks like:
  //   <script type="module" crossorigin src="/assets/index-XXX.js"></script>
  const match = html.match(
    /<script[^>]+type="module"[^>]+src="([^"]+)"[^>]*>/i,
  );
  if (match === null || match[1] === undefined) {
    throw new Error(
      "bundle-size.test: failed to locate entry <script> in dist/ui/index.html",
    );
  }
  // The src is server-absolute (`/assets/index-…`); resolve
  // against DIST_ROOT to get the on-disk path.
  return resolve(DIST_ROOT, "./" + match[1].replace(/^\//, ""));
}

/** All `*.js` chunks in `dist/ui/assets/`, excluding sourcemaps. */
function listJsChunks(): readonly string[] {
  const entries = readdirSync(DIST_ASSETS);
  return entries.filter((f) => f.endsWith(".js") && !f.endsWith(".js.map"));
}

describe("UI bundle size fence (PR-B2)", () => {
  it("dist/ui exists (skip locally if not — run `pnpm --filter @opencoo/ui build` first)", () => {
    if (distMissing()) {
      // Soft-skip: log a hint, don't fail. CI guarantees the
      // build runs before this test pass; locals get a clear
      // pointer instead of an opaque red test.
      console.warn(
        "[bundle-size] dist/ui is absent; run `pnpm --filter @opencoo/ui build` to enable the fence.",
      );
      return;
    }
    expect(existsSync(DIST_INDEX_HTML)).toBe(true);
    expect(existsSync(DIST_ASSETS)).toBe(true);
  });

  it(`entry chunk gzipped size is <= ${ENTRY_CHUNK_BUDGET_KB} KB`, () => {
    if (distMissing()) return;
    const entry = resolveEntryChunkPath();
    expect(existsSync(entry)).toBe(true);
    const raw = readFileSync(entry);
    const gz = gzipSync(raw);
    const kb = gz.byteLength / 1024;
    // Log the observed size so the PR description can record it.
    console.warn(
      `[bundle-size] entry chunk gzipped: ${kb.toFixed(2)} KB (budget ${ENTRY_CHUNK_BUDGET_KB} KB)`,
    );
    expect(kb).toBeLessThanOrEqual(ENTRY_CHUNK_BUDGET_KB);
  });

  it(`dist/ui/assets contains >= ${MIN_ROUTE_CHUNKS} JS chunks (route code-split landed)`, () => {
    if (distMissing()) return;
    const chunks = listJsChunks();
    console.warn(
      `[bundle-size] dist/ui/assets js-chunk count: ${chunks.length} (route chunks min ${MIN_ROUTE_CHUNKS} + entry)`,
    );
    // Expected: 1 entry + >=7 route chunks (Vite may co-bundle
    // some routes if they share heavy graphs — the floor of 7
    // is documented in the test header).
    expect(chunks.length).toBeGreaterThanOrEqual(MIN_ROUTE_CHUNKS + 1);
  });

  it("every route chunk exists as a distinct file (no inline drift)", () => {
    if (distMissing()) return;
    const chunks = listJsChunks();
    // Vite hashes the filename; the chunk basename for a lazy
    // route is the source file's name (Vite default chunk-name
    // strategy). Each of the 11 routes must surface as its own
    // file — if one were inlined into the entry chunk it would
    // not appear here.
    const routeNames = [
      "Activity",
      "Agents",
      "Audit",
      "Cost",
      "Domains",
      "LlmPolicy",
      "Outputs",
      "Prompts",
      "Reports",
      "Review",
      "Sources",
    ];
    const missing: string[] = [];
    for (const route of routeNames) {
      const hit = chunks.find((f) => f.startsWith(route + "-"));
      if (hit === undefined) missing.push(route);
    }
    // The pin is tighter than the "≥7" floor: every named
    // route should ship as its own chunk. Drift here = "lazy
    // boundary was removed for route X".
    expect(missing, `routes missing distinct chunks: ${missing.join(", ")}`).toEqual([]);
  });
});
