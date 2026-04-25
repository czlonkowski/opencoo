/**
 * `validateAllowedPath` is the binding-level path guard for
 * Classifier output: it accepts a candidate page path and the
 * binding's `allowed_paths` glob list, and throws when the
 * candidate is outside the allow-list.
 *
 * This is layered ON TOP of @opencoo/shared/wiki-write's
 * `validatePath` (shape check: lowercase, valid extension, no
 * `..`, no `wiki-` prefix). The two run together — the classifier
 * pipeline calls both and DLQs on either failure.
 *
 * Per Q4: glob matcher is `picomatch` with `dot:false` (default)
 * and `nocase:false` (paths are case-sensitive in the wiki repo
 * by convention).
 */
import { describe, it, expect } from "vitest";

import {
  validateAllowedPath,
  ClassifierPathError,
} from "../../src/classifier/path-guard.js";

describe("validateAllowedPath — happy path", () => {
  it("accepts a path matching a single glob", () => {
    expect(() =>
      validateAllowedPath("strategy/q3.md", ["strategy/**"]),
    ).not.toThrow();
  });

  it("accepts a path matching one of several globs", () => {
    expect(() =>
      validateAllowedPath("executive/intro.md", [
        "strategy/**",
        "executive/**",
        "log.md",
      ]),
    ).not.toThrow();
  });

  it("accepts a literal-path match", () => {
    expect(() =>
      validateAllowedPath("log.md", ["log.md", "strategy/**"]),
    ).not.toThrow();
  });

  it("accepts deeply nested paths under `**`", () => {
    expect(() =>
      validateAllowedPath(
        "strategy/products/2026/q1/launch.md",
        ["strategy/**"],
      ),
    ).not.toThrow();
  });
});

describe("validateAllowedPath — rejection", () => {
  it("rejects a path that does not match any glob", () => {
    expect(() =>
      validateAllowedPath("hr/onboarding.md", ["strategy/**", "executive/**"]),
    ).toThrow(ClassifierPathError);
  });

  it("rejects a path traversal attempt (../)", () => {
    expect(() =>
      validateAllowedPath("strategy/../hr/secret.md", ["strategy/**"]),
    ).toThrow(ClassifierPathError);
  });

  it("rejects an absolute path", () => {
    expect(() =>
      validateAllowedPath("/strategy/q3.md", ["strategy/**"]),
    ).toThrow(ClassifierPathError);
  });

  it("rejects empty path", () => {
    expect(() =>
      validateAllowedPath("", ["strategy/**"]),
    ).toThrow(ClassifierPathError);
  });

  it("ClassifierPathError carries path + allowed list + errorClass", () => {
    try {
      validateAllowedPath("hr/x.md", ["strategy/**"]);
      expect.fail("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClassifierPathError);
      const e = err as ClassifierPathError;
      expect(e.errorClass).toBe("validation");
      expect(e.path).toBe("hr/x.md");
      expect(e.allowedPaths).toEqual(["strategy/**"]);
    }
  });
});

describe("validateAllowedPath — case sensitivity", () => {
  it("matches case-sensitively (Strategy != strategy)", () => {
    // The wiki repo is case-sensitive on disk; matching must follow.
    expect(() =>
      validateAllowedPath("Strategy/x.md", ["strategy/**"]),
    ).toThrow(ClassifierPathError);
  });
});

describe("validateAllowedPath — interaction with shape guard", () => {
  it("rejects shape-invalid paths (uppercase letters) even when glob would match", () => {
    // The shape guard from @opencoo/shared/wiki-write rejects
    // uppercase letters; the path guard must surface the shape
    // failure even when the glob "would" have matched.
    expect(() =>
      validateAllowedPath("strategy/Q3.md", ["strategy/**"]),
    ).toThrow();
  });

  it("rejects `wiki-` prefix paths regardless of glob match", () => {
    expect(() =>
      validateAllowedPath("strategy/wiki-x.md", ["strategy/**"]),
    ).toThrow();
  });
});
