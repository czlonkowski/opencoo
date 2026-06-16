/**
 * Producer → validator oracle: the bytes our deterministic compilers
 * emit must pass the OKF conformance validator. Guards against a
 * quoting/format bug that would make a page non-conformant only once
 * the wiki-write gate flips to 'throw'.
 */
import { describe, expect, it } from "vitest";

import { validatePageConformance } from "@opencoo/shared/page-spec";

import { buildCatalogWorkflowBody } from "../../src/compiler/catalog-workflow.js";
import { buildFrontmatter } from "../../src/compiler/frontmatter.js";

describe("compiler output is OKF-conformant", () => {
  it("a document-compiled knowledge page passes validatePageConformance", () => {
    const fm = buildFrontmatter({
      title: "Q3: roadmap & priorities",
      type: "Knowledge Page",
      pagePath: "strategy/q3.md",
      domainSlug: "wiki-exec",
      compiledAt: new Date("2026-04-25T12:00:00Z"),
      promptVersion: "1.0.0",
    });
    const page = `${fm}# Q3\n\nBody text.\n`;
    const r = validatePageConformance({
      path: "strategy/q3.md",
      content: page,
    });
    expect(r.violations).toEqual([]);
    expect(r.conformant).toBe(true);
  });

  it("a catalog-workflow page passes validatePageConformance", () => {
    const { body } = buildCatalogWorkflowBody({
      workflow: { id: "wf1", name: "My Flow", tags: ["catalog"] },
      domainSlug: "automations",
      compiledAt: new Date("2026-04-25T12:00:00Z"),
    });
    const r = validatePageConformance({
      path: "catalog/workflows/my-flow-wf1.md",
      content: body,
    });
    expect(r.violations).toEqual([]);
    expect(r.conformant).toBe(true);
  });
});
