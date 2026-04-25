/**
 * `assertBindingNotWildcardOnly` is a fail-closed runtime guard
 * that rejects bindings whose `allowed_paths` is empty OR consists
 * entirely of catch-all globs. THREAT-MODEL §3.4 explicitly forbids
 * `["**"]` because it would let a compromised classifier write to
 * any path in the domain.
 *
 * The Management UI (PR 29) rejects these at create-time, but the
 * engine MUST refuse at runtime too — defense in depth against a
 * direct DB poke or a future config-importer that bypasses the UI.
 *
 * Per Q5: rejected shapes are []  (no paths at all),
 * the literal wildcard alone, the wildcard mixed with anything
 * else (still admits everything), and any catch-every-parent
 * pattern — see the test cases below for the concrete strings.
 */
import { describe, it, expect } from "vitest";

import {
  assertBindingNotWildcardOnly,
  BindingConfigError,
} from "../../src/classifier/binding-guard.js";

describe("assertBindingNotWildcardOnly", () => {
  it("accepts a single specific glob", () => {
    expect(() => assertBindingNotWildcardOnly(["strategy/**"])).not.toThrow();
  });

  it("accepts multiple specific globs", () => {
    expect(() =>
      assertBindingNotWildcardOnly([
        "strategy/**",
        "executive/**",
        "log.md",
      ]),
    ).not.toThrow();
  });

  it("accepts a single literal page path", () => {
    expect(() =>
      assertBindingNotWildcardOnly(["index.md"]),
    ).not.toThrow();
  });

  it("rejects an empty array", () => {
    expect(() => assertBindingNotWildcardOnly([])).toThrow(
      BindingConfigError,
    );
  });

  it("rejects [`**`]", () => {
    expect(() => assertBindingNotWildcardOnly(["**"])).toThrow(
      BindingConfigError,
    );
  });

  it("rejects [`**`, `specific.md`] — `**` poisons the whole set", () => {
    expect(() =>
      assertBindingNotWildcardOnly(["**", "specific.md"]),
    ).toThrow(BindingConfigError);
  });

  it("rejects [`**/foo`] — catches every parent path", () => {
    expect(() => assertBindingNotWildcardOnly(["**/foo"])).toThrow(
      BindingConfigError,
    );
  });

  it("rejects [`**/foo.md`] — same shape", () => {
    expect(() =>
      assertBindingNotWildcardOnly(["**/foo.md"]),
    ).toThrow(BindingConfigError);
  });

  it("ACCEPTS [`foo/**`] — bounded prefix is safe", () => {
    expect(() =>
      assertBindingNotWildcardOnly(["foo/**"]),
    ).not.toThrow();
  });

  it("ACCEPTS a concrete nested literal path — no leading wildcard means safe", () => {
    // Documents the boundary: planner's call (Q5) is to reject
    // ANY pattern that starts with the leading-globstar shape
    // (the previous test pins that). A fully-concrete path with
    // no globs in it is the opposite end of the spectrum and
    // must pass — it identifies exactly one file.
    expect(() =>
      assertBindingNotWildcardOnly(["specific/dir/file.md"]),
    ).not.toThrow();
  });

  it("BindingConfigError carries the offending list + errorClass:'validation'", () => {
    try {
      assertBindingNotWildcardOnly(["**"]);
      expect.fail("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BindingConfigError);
      const e = err as BindingConfigError;
      expect(e.errorClass).toBe("validation");
      expect(e.allowedPaths).toEqual(["**"]);
      expect(e.message.toLowerCase()).toMatch(/wildcard|allowed_paths|empty/);
    }
  });
});
