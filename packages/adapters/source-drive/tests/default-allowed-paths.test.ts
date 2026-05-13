/**
 * Drift-prevention test for `DEFAULT_ALLOWED_PATHS` (PR-W1 of
 * phase-a appendix #14).
 *
 * The adapter exports `DEFAULT_ALLOWED_PATHS` for the Management UI
 * chip-suggestions surface; the authoritative registry lives in
 * `@opencoo/shared/source-adapter`. Both must agree — a drift here
 * means the partner-fixture bootstrap (which imports from the
 * adapter) and the UI suggestions (which read the engine's
 * GET /api/admin/adapters, which reads the shared registry) would
 * disagree on which subtrees are sensible by default.
 */
import { describe, expect, it } from "vitest";

import { getDefaultAllowedPaths } from "@opencoo/shared/source-adapter";

import { DEFAULT_ALLOWED_PATHS, DRIVE_ADAPTER_SLUG } from "../src/index.js";

describe("source-drive DEFAULT_ALLOWED_PATHS", () => {
  it("matches the shared registry verbatim", () => {
    const shared = getDefaultAllowedPaths(DRIVE_ADAPTER_SLUG);
    expect(shared).toEqual([...DEFAULT_ALLOWED_PATHS]);
  });

  it("is non-empty", () => {
    expect(DEFAULT_ALLOWED_PATHS.length).toBeGreaterThan(0);
  });

  it("avoids bare-wildcard shapes that the runtime classifier guard rejects", () => {
    // Mirrors `assertBindingNotWildcardOnly` (engine-ingestion's
    // binding-guard.ts) — the adapter package cannot import from
    // engine-ingestion (boundary rule), so the accept-set is
    // re-asserted here. The shared-registry drift test
    // (`packages/shared/tests/source-adapter/default-allowed-paths.test.ts`)
    // does the canonical runtime-guard pass.
    for (const pattern of DEFAULT_ALLOWED_PATHS) {
      expect(pattern).not.toBe("**");
      expect(pattern.startsWith("**/")).toBe(false);
    }
  });
});
