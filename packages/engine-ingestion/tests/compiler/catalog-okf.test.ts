/**
 * catalog-okf — deterministic passthrough compile for
 * `content_kind: 'okf-bundle'` (PR-OKF3).
 *
 * An OKF concept doc (markdown + YAML frontmatter) is ingested
 * verbatim: the OKF frontmatter is mapped to opencoo provenance
 * frontmatter and the markdown body is committed AS-IS (no fence,
 * no LLM). Round-trip fidelity is the load-bearing property.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { validatePageConformance } from "@opencoo/shared/page-spec";
import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  buildOkfBundleBody,
  catalogPagePathForOkfConcept,
  compileOkfConcept,
} from "../../src/compiler/catalog-okf.js";

import { freshCompilerDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const AUTHOR = {
  name: "opencoo-compiler",
  email: "compiler@opencoo.local",
} as const;

function makeWikiDeps(adapter: InMemoryWikiAdapter): WikiWriteDeps {
  return {
    adapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: new InMemoryDeleteCap(),
    logger: silentLogger(),
    clock: () => COMPILED_AT,
    instanceId: "test",
  };
}

type ReadPageSlug = Parameters<InMemoryWikiAdapter["readPage"]>[0];

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

  it("preserves the source OKF timestamp (lossless), not the compile time", () => {
    const { body } = buildOkfBundleBody({
      conceptId: "tables/orders",
      content: OKF_CONCEPT, // timestamp: 2026-05-28T00:00:00Z
      domainSlug: "wiki-data",
      compiledAt: COMPILED_AT, // 2026-04-25
    });
    expect(body).toContain('timestamp: "2026-05-28T00:00:00.000Z"');
    // compiled_at still records OUR import time.
    expect(body).toContain('compiled_at: "2026-04-25T12:00:00.000Z"');
  });

  it("falls back to compiled_at when the source has no timestamp", () => {
    const noTs = "---\ntype: Note\ntitle: X\n---\n\nBody.\n";
    const { body } = buildOkfBundleBody({
      conceptId: "notes/x",
      content: noTs,
      domainSlug: "d",
      compiledAt: COMPILED_AT,
    });
    expect(body).toContain('timestamp: "2026-04-25T12:00:00.000Z"');
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

describe("compileOkfConcept — orchestration", () => {
  it("writes one replace op to the concept's mirrored page path", async () => {
    const f = await freshCompilerDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const result = await compileOkfConcept({
      db: f.db as unknown as Parameters<typeof compileOkfConcept>[0]["db"],
      domainId: f.domainId as Parameters<typeof compileOkfConcept>[0]["domainId"],
      domainSlug: "wiki-data",
      bindingId: f.bindingId as Parameters<typeof compileOkfConcept>[0]["bindingId"],
      sourceRef: "tables/orders",
      content: OKF_CONCEPT,
      wikiDeps: makeWikiDeps(wikiAdapter),
      author: AUTHOR,
    });
    expect(result.commitSha).not.toBeNull();
    expect(result.pagePath).toBe("tables/orders.md");
    const page = await wikiAdapter.readPage(
      "wiki-data" as ReadPageSlug,
      "tables/orders.md",
    );
    expect(page?.content).toContain("type: BigQuery Table");
    expect(page?.content).toContain("# Schema");
  });

  it("appends a page_citations row with prompt_version catalog-okf:1.0", async () => {
    const f = await freshCompilerDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    await compileOkfConcept({
      db: f.db as unknown as Parameters<typeof compileOkfConcept>[0]["db"],
      domainId: f.domainId as Parameters<typeof compileOkfConcept>[0]["domainId"],
      domainSlug: "wiki-data",
      bindingId: f.bindingId as Parameters<typeof compileOkfConcept>[0]["bindingId"],
      sourceRef: "tables/orders",
      content: OKF_CONCEPT,
      wikiDeps: makeWikiDeps(wikiAdapter),
      author: AUTHOR,
    });
    const rows = (await f.db.execute(
      sql`SELECT prompt_version, source_ref FROM page_citations`,
    )) as unknown as {
      rows: Array<{ prompt_version: string; source_ref: string }>;
    };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.prompt_version).toBe("catalog-okf:1.0");
    expect(rows.rows[0]?.source_ref).toBe("tables/orders");
  });

  it("re-running with identical content is a no-op (skip-write)", async () => {
    const f = await freshCompilerDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const writeSpy = vi.spyOn(wikiAdapter, "writeAtomic");
    const args = {
      db: f.db as unknown as Parameters<typeof compileOkfConcept>[0]["db"],
      domainId: f.domainId as Parameters<typeof compileOkfConcept>[0]["domainId"],
      domainSlug: "wiki-data",
      bindingId: f.bindingId as Parameters<typeof compileOkfConcept>[0]["bindingId"],
      sourceRef: "tables/orders",
      content: OKF_CONCEPT,
      wikiDeps: makeWikiDeps(wikiAdapter),
      author: AUTHOR,
    };
    await compileOkfConcept(args);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const second = await compileOkfConcept(args);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(second.commitSha).toBeNull();
  });
});

describe("catalog-okf — deterministic (no LLM)", () => {
  it("does not import @opencoo/shared/llm-router", () => {
    const src = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../src/compiler/catalog-okf.ts",
      ),
      "utf8",
    );
    // Assert no IMPORT of llm-router (a comment mention is fine).
    expect(src).not.toMatch(/from\s+["']@opencoo\/shared\/llm-router["']/);
  });
});
