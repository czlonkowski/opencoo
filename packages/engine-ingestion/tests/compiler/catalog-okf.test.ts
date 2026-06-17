/**
 * catalog-okf — deterministic passthrough compile for
 * `content_kind: 'okf-bundle'` (PR-OKF3).
 *
 * An OKF concept doc (markdown + YAML frontmatter) is ingested
 * verbatim: the OKF frontmatter is mapped to opencoo provenance
 * frontmatter and the markdown body is committed AS-IS (no fence,
 * no LLM). Round-trip fidelity is the load-bearing property.
 */
import { describe, expect, it } from "vitest";

import { validatePageConformance } from "@opencoo/shared/page-spec";

import {
  buildOkfBundleBody,
  catalogPagePathForOkfConcept,
} from "../../src/compiler/catalog-okf.js";

const OKF_CONCEPT = `---
type: BigQuery Table
title: Orders
description: One row per completed order.
resource: https://console.cloud.google.com/bigquery?t=orders
tags: [sales, orders]
timestamp: 2026-05-28T00:00:00Z
---

# Schema

| Column     | Type   |
|------------|--------|
| order_id   | STRING |

See [customers](/tables/customers.md).
`;

const COMPILED_AT = new Date("2026-04-25T12:00:00Z");

describe("catalogPagePathForOkfConcept", () => {
  it("mirrors the concept id to a .md page path", () => {
    expect(catalogPagePathForOkfConcept("tables/orders")).toBe(
      "tables/orders.md",
    );
  });

  it("strips a leading slash and trailing .md if present", () => {
    expect(catalogPagePathForOkfConcept("/tables/orders")).toBe(
      "tables/orders.md",
    );
    expect(catalogPagePathForOkfConcept("tables/orders.md")).toBe(
      "tables/orders.md",
    );
  });
});

describe("buildOkfBundleBody — frontmatter mapping", () => {
  it("preserves the OKF type/title/description/resource/tags", () => {
    const { body } = buildOkfBundleBody({
      conceptId: "tables/orders",
      content: OKF_CONCEPT,
      domainSlug: "wiki-data",
      compiledAt: COMPILED_AT,
    });
    expect(body).toContain("type: BigQuery Table");
    expect(body).toContain("title: Orders");
    expect(body).toContain("description: One row per completed order.");
    // URLs contain `:` / `?` → quoted by yamlQuoteIfNeeded.
    expect(body).toContain(
      'resource: "https://console.cloud.google.com/bigquery?t=orders"',
    );
    expect(body).toMatch(/^tags:/m);
  });

  it("adds opencoo provenance: page_path, domain_slug, compiled_at, source_id, schema_version", () => {
    const { body } = buildOkfBundleBody({
      conceptId: "tables/orders",
      content: OKF_CONCEPT,
      domainSlug: "wiki-data",
      compiledAt: COMPILED_AT,
    });
    expect(body).toContain("page_path: tables/orders.md");
    expect(body).toContain("domain_slug: wiki-data");
    expect(body).toContain('compiled_at: "2026-04-25T12:00:00.000Z"');
    expect(body).toContain("source_id: tables/orders");
    expect(body).toContain("schema_version: 1.0.0");
  });

  it("commits the markdown body verbatim below the frontmatter", () => {
    const { body, bodyWithoutFrontmatter } = buildOkfBundleBody({
      conceptId: "tables/orders",
      content: OKF_CONCEPT,
      domainSlug: "wiki-data",
      compiledAt: COMPILED_AT,
    });
    expect(bodyWithoutFrontmatter).toContain("# Schema");
    expect(bodyWithoutFrontmatter).toContain(
      "See [customers](/tables/customers.md).",
    );
    // the fenced approach is NOT used — no ```okf fence
    expect(body).not.toContain("```okf");
  });

  it("produces an OKF-conformant opencoo page", () => {
    const { body } = buildOkfBundleBody({
      conceptId: "tables/orders",
      content: OKF_CONCEPT,
      domainSlug: "wiki-data",
      compiledAt: COMPILED_AT,
    });
    const r = validatePageConformance({
      path: "tables/orders.md",
      content: body,
    });
    expect(r.violations).toEqual([]);
    expect(r.conformant).toBe(true);
  });
});

describe("buildOkfBundleBody — permissive import of non-conformant sources", () => {
  it("falls back to type Reference when the OKF concept has no type", () => {
    const noType = "---\ntitle: Stray\n---\n\nBody.\n";
    const { body } = buildOkfBundleBody({
      conceptId: "notes/stray",
      content: noType,
      domainSlug: "d",
      compiledAt: COMPILED_AT,
    });
    expect(body).toContain("type: Reference");
    const r = validatePageConformance({ path: "notes/stray.md", content: body });
    expect(r.conformant).toBe(true);
  });

  it("derives a title from the concept id when the OKF concept has none", () => {
    const noTitle = "---\ntype: Note\n---\n\nBody.\n";
    const { body } = buildOkfBundleBody({
      conceptId: "notes/weekly-sync",
      content: noTitle,
      domainSlug: "d",
      compiledAt: COMPILED_AT,
    });
    expect(body).toContain("title: Weekly-sync");
  });

  it("treats a plain-markdown concept (no frontmatter) as the body", () => {
    const plain = "# Just markdown\n\nNo frontmatter at all.\n";
    const { body, bodyWithoutFrontmatter } = buildOkfBundleBody({
      conceptId: "notes/plain",
      content: plain,
      domainSlug: "d",
      compiledAt: COMPILED_AT,
    });
    expect(bodyWithoutFrontmatter).toContain("# Just markdown");
    const r = validatePageConformance({ path: "notes/plain.md", content: body });
    expect(r.conformant).toBe(true);
  });
});
