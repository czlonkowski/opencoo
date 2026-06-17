import { describe, expect, it } from "vitest";

import {
  isBundleRootIndex,
  isReserved,
  RESERVED_FILENAMES,
} from "../../src/page-spec/reserved.js";

// OKF v0.1 SPEC §3.1: `index.md` and `log.md` have defined meaning at ANY
// level of the hierarchy and MUST NOT be used for concept documents.
describe("RESERVED_FILENAMES", () => {
  it("is exactly index.md and log.md", () => {
    expect([...RESERVED_FILENAMES]).toEqual(["index.md", "log.md"]);
  });
});

describe("isReserved", () => {
  it("treats index.md and log.md as reserved at the bundle root", () => {
    expect(isReserved("index.md")).toBe(true);
    expect(isReserved("log.md")).toBe(true);
  });

  it("treats index.md and log.md as reserved at any nesting level", () => {
    expect(isReserved("strategy/index.md")).toBe(true);
    expect(isReserved("a/b/log.md")).toBe(true);
  });

  it("treats a normal concept page as not reserved", () => {
    expect(isReserved("strategy/q3.md")).toBe(false);
    expect(isReserved("catalog/workflows/foo-1.md")).toBe(false);
  });

  it("ignores a leading slash on bundle-relative paths", () => {
    expect(isReserved("/index.md")).toBe(true);
  });
});

describe("isBundleRootIndex", () => {
  it("is true only for the root-level index.md (the one place okf_version may live)", () => {
    expect(isBundleRootIndex("index.md")).toBe(true);
    expect(isBundleRootIndex("/index.md")).toBe(true);
  });

  it("is false for a nested index.md", () => {
    expect(isBundleRootIndex("strategy/index.md")).toBe(false);
  });

  it("is false for log.md and ordinary concept pages", () => {
    expect(isBundleRootIndex("log.md")).toBe(false);
    expect(isBundleRootIndex("strategy/q3.md")).toBe(false);
  });
});
