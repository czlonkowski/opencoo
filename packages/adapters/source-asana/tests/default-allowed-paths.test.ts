/**
 * Drift-prevention test for `DEFAULT_ALLOWED_PATHS` (PR-W1 of
 * phase-a appendix #14). Mirrors the sister test in
 * `source-drive`, `source-fireflies`, `source-n8n`.
 */
import { describe, expect, it } from "vitest";

import { getDefaultAllowedPaths } from "@opencoo/shared/source-adapter";

import { ASANA_ADAPTER_SLUG, DEFAULT_ALLOWED_PATHS } from "../src/index.js";

describe("source-asana DEFAULT_ALLOWED_PATHS", () => {
  it("matches the shared registry verbatim", () => {
    const shared = getDefaultAllowedPaths(ASANA_ADAPTER_SLUG);
    expect(shared).toEqual([...DEFAULT_ALLOWED_PATHS]);
  });

  it("is non-empty", () => {
    expect(DEFAULT_ALLOWED_PATHS.length).toBeGreaterThan(0);
  });

  it("avoids bare-wildcard shapes that the runtime classifier guard rejects", () => {
    for (const pattern of DEFAULT_ALLOWED_PATHS) {
      expect(pattern).not.toBe("**");
      expect(pattern.startsWith("**/")).toBe(false);
    }
  });
});
