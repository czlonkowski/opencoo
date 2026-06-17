/**
 * Drift-prevention test for `DEFAULT_ALLOWED_PATHS` (PR-OKF3b).
 * Mirrors the sister test in `source-n8n` / `source-drive` etc.
 *
 * NOTE: allowed_paths is advisory for `okf-bundle` bindings — the
 * compile path mirrors each concept to its bundle path verbatim and
 * does NOT gate on allowed_paths (only the LLM `document` path does).
 * The entry still must pass the create-time wildcard guard, so the
 * registry keeps a bounded, non-wildcard default.
 */
import { describe, expect, it } from "vitest";

import { getDefaultAllowedPaths } from "@opencoo/shared/source-adapter";

import { DEFAULT_ALLOWED_PATHS, OKF_ADAPTER_SLUG } from "../src/index.js";

describe("source-okf DEFAULT_ALLOWED_PATHS", () => {
  it("matches the shared registry verbatim", () => {
    const shared = getDefaultAllowedPaths(OKF_ADAPTER_SLUG);
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
