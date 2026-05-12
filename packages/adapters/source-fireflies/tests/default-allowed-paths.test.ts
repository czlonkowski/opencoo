/**
 * Drift-prevention test for `DEFAULT_ALLOWED_PATHS` (PR-W1 of
 * phase-a appendix #14). Mirrors the sister test in
 * `source-drive`, `source-asana`, `source-n8n`.
 */
import { describe, expect, it } from "vitest";

import { getDefaultAllowedPaths } from "@opencoo/shared/source-adapter";

import {
  DEFAULT_ALLOWED_PATHS,
  FIREFLIES_ADAPTER_SLUG,
} from "../src/index.js";

describe("source-fireflies DEFAULT_ALLOWED_PATHS", () => {
  it("matches the shared registry verbatim", () => {
    const shared = getDefaultAllowedPaths(FIREFLIES_ADAPTER_SLUG);
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
