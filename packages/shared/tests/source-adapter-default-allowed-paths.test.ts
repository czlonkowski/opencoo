/**
 * `SOURCE_ADAPTER_DEFAULT_ALLOWED_PATHS` — registry shape (PR-W1 of
 * phase-a appendix #14).
 *
 * Pin matrix:
 *   1. Registry covers every adapter slug
 *      (`SOURCE_ADAPTER_CREDENTIAL_SCHEMAS` is the slug source of
 *      truth — both registries must agree).
 *   2. Every entry is non-empty.
 *   3. No entry contains a wildcard-shaped pattern (the runtime
 *      classifier guard would reject it — see
 *      `packages/engine-ingestion/src/classifier/binding-guard.ts`).
 *   4. `getDefaultAllowedPaths` returns `undefined` for unknown
 *      slugs (matches `getSourceAdapterDescriptor`'s shape).
 *
 * A parallel test in `engine-ingestion` (`binding-guard.test.ts`)
 * asserts the guard ACCEPTS each entry verbatim — that test crosses
 * the boundary (engine-ingestion → shared); this one stays inside
 * shared so a shared-package-only test run still catches drift.
 */
import { describe, expect, it } from "vitest";

import {
  SOURCE_ADAPTER_CREDENTIAL_SCHEMAS,
  SOURCE_ADAPTER_DEFAULT_ALLOWED_PATHS,
  getDefaultAllowedPaths,
} from "../src/source-adapter/index.js";

describe("SOURCE_ADAPTER_DEFAULT_ALLOWED_PATHS", () => {
  it("covers every adapter slug in the credential-schema registry", () => {
    const credentialSlugs = Object.keys(SOURCE_ADAPTER_CREDENTIAL_SCHEMAS)
      .slice()
      .sort();
    const defaultPathsSlugs = Object.keys(SOURCE_ADAPTER_DEFAULT_ALLOWED_PATHS)
      .slice()
      .sort();
    expect(defaultPathsSlugs).toEqual(credentialSlugs);
  });

  it("every entry is non-empty", () => {
    for (const [slug, paths] of Object.entries(
      SOURCE_ADAPTER_DEFAULT_ALLOWED_PATHS,
    )) {
      expect(paths.length, `slug=${slug}`).toBeGreaterThan(0);
    }
  });

  it("rejects wildcard-shaped patterns (mirrors assertBindingNotWildcardOnly)", () => {
    for (const [slug, paths] of Object.entries(
      SOURCE_ADAPTER_DEFAULT_ALLOWED_PATHS,
    )) {
      for (const pattern of paths) {
        expect(pattern, `slug=${slug}`).not.toBe("**");
        expect(
          pattern.startsWith("**/"),
          `slug=${slug} pattern=${pattern}`,
        ).toBe(false);
        expect(pattern.length, `slug=${slug}`).toBeGreaterThan(0);
      }
    }
  });

  it("getDefaultAllowedPaths returns undefined for unknown slugs", () => {
    expect(getDefaultAllowedPaths("does-not-exist")).toBeUndefined();
  });

  it("getDefaultAllowedPaths returns the registry entry for known slugs", () => {
    expect(getDefaultAllowedPaths("drive")).toEqual([
      "meetings/**",
      "transcripts/**",
      "docs/**",
    ]);
    expect(getDefaultAllowedPaths("asana")).toEqual([
      "projects/**",
      "tasks/**",
    ]);
    expect(getDefaultAllowedPaths("fireflies")).toEqual(["meetings/**"]);
    expect(getDefaultAllowedPaths("n8n")).toEqual(["workflows/**"]);
  });
});
