/**
 * source-okf — binding-config schema (PR-OKF3b).
 *
 * The adapter walks a local OKF v0.1 bundle directory and emits each
 * concept doc as an `okf-bundle` document. `bundlePath` is the only
 * required field; `subdir` optionally scopes the walk; `contentKind`
 * is locked to `'okf-bundle'` for v0.1 (the shared CONTENT_KINDS enum
 * is the source of truth, accepted broadly for forward-compat — mirrors
 * source-n8n).
 */
import { describe, expect, it } from "vitest";

import {
  OKF_DEFAULT_CONTENT_KIND,
  okfBindingConfigSchema,
  type OkfBindingConfig,
} from "../src/binding-config.js";

describe("source-okf — binding-config schema", () => {
  it("requires bundlePath", () => {
    expect(() => okfBindingConfigSchema.parse({})).toThrow();
  });

  it("rejects an empty bundlePath", () => {
    expect(() => okfBindingConfigSchema.parse({ bundlePath: "" })).toThrow();
  });

  it("defaults contentKind to 'okf-bundle'", () => {
    const parsed = okfBindingConfigSchema.parse({ bundlePath: "/srv/okf" });
    expect(parsed.contentKind).toBe("okf-bundle");
    expect(parsed.contentKind).toBe(OKF_DEFAULT_CONTENT_KIND);
  });

  it("leaves subdir undefined by default", () => {
    const parsed = okfBindingConfigSchema.parse({ bundlePath: "/srv/okf" });
    expect(parsed.subdir).toBeUndefined();
  });

  it("accepts an optional subdir", () => {
    const parsed = okfBindingConfigSchema.parse({
      bundlePath: "/srv/okf",
      subdir: "datasets",
    });
    expect(parsed.subdir).toBe("datasets");
  });

  it("accepts a nested in-bundle subdir", () => {
    const parsed = okfBindingConfigSchema.parse({
      bundlePath: "/srv/okf",
      subdir: "a/b",
    });
    expect(parsed.subdir).toBe("a/b");
  });

  it("rejects a subdir with a '..' segment (path traversal)", () => {
    expect(() =>
      okfBindingConfigSchema.parse({ bundlePath: "/srv/okf", subdir: "../etc" }),
    ).toThrow();
    expect(() =>
      okfBindingConfigSchema.parse({
        bundlePath: "/srv/okf",
        subdir: "datasets/../../etc",
      }),
    ).toThrow();
  });

  it("rejects an absolute subdir", () => {
    expect(() =>
      okfBindingConfigSchema.parse({ bundlePath: "/srv/okf", subdir: "/etc" }),
    ).toThrow();
  });

  it("accepts a non-default contentKind from the shared enum (forward-compat)", () => {
    const parsed = okfBindingConfigSchema.parse({
      bundlePath: "/srv/okf",
      contentKind: "document",
    });
    expect(parsed.contentKind).toBe("document");
  });

  it("rejects a contentKind outside the shared enum", () => {
    expect(() =>
      okfBindingConfigSchema.parse({
        bundlePath: "/srv/okf",
        contentKind: "not-a-kind",
      }),
    ).toThrow();
  });

  it("rejects unknown top-level fields (.strict)", () => {
    expect(() =>
      okfBindingConfigSchema.parse({ bundlePath: "/srv/okf", ghost: "no" }),
    ).toThrow();
  });

  it("infers the OkfBindingConfig type", () => {
    const cfg: OkfBindingConfig = okfBindingConfigSchema.parse({
      bundlePath: "/srv/okf",
    });
    expect(cfg.bundlePath).toBe("/srv/okf");
  });
});
