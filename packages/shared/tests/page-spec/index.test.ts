import { describe, expect, it } from "vitest";

import * as pageSpec from "../../src/page-spec/index.js";

// Guards the package-public surface: if a re-export is dropped from the
// barrel, the engine/adapters that import `@opencoo/shared/page-spec`
// break — catch it here, in the use-case tier.
describe("page-spec public API", () => {
  it("re-exports the conformance validator and schema surface", () => {
    expect(typeof pageSpec.validatePageConformance).toBe("function");
    expect(typeof pageSpec.parseFrontmatter).toBe("function");
    expect(typeof pageSpec.isReserved).toBe("function");
    expect(typeof pageSpec.isBundleRootIndex).toBe("function");
    expect(pageSpec.RESERVED_FILENAMES).toBeDefined();
    expect(pageSpec.OKF_VERSION).toBe("0.1");
    expect(pageSpec.okfFrontmatterSchema).toBeDefined();
  });

  it("end-to-end: a page built to spec validates clean through the barrel", () => {
    const content = "---\ntype: Knowledge Page\ntitle: X\n---\nBody.\n";
    const r = pageSpec.validatePageConformance({ path: "a/b.md", content });
    expect(r.conformant).toBe(true);
  });
});
