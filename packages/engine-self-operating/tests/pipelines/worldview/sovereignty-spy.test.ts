/**
 * LOAD-BEARING sovereignty assertion (PR 22 / plan #106).
 *
 * The company-aggregator pipeline MUST NOT call
 * `wikiAdapter.readPage` with `path !== 'worldview.md'` for
 * non-aggregator domains. The SovereigntySpyWikiAdapter wraps
 * any base WikiAdapter and throws WorldviewSovereigntyError
 * if the constraint is violated. Production wires the same
 * wrapper at engine boot; this test pins the wrapper's
 * behavior directly.
 */
import { describe, expect, it } from "vitest";

import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import type { DomainSlug } from "@opencoo/shared/db";

import {
  SovereigntySpyWikiAdapter,
  WorldviewSovereigntyError,
} from "../../../src/pipelines/worldview/index.js";

function seedAdapter(): InMemoryWikiAdapter {
  const adapter = new InMemoryWikiAdapter();
  // Simulate already-compiled worldviews via the test-only
  // inject backdoor (the adapter ships this for tests).
  adapter.inject(
    "exec" as DomainSlug,
    "worldview.md",
    "# exec worldview body",
  );
  adapter.inject("exec" as DomainSlug, "team/eng.md", "# eng page");
  adapter.inject("exec" as DomainSlug, "projects/q3.md", "# q3 page");
  adapter.inject(
    "hr" as DomainSlug,
    "worldview.md",
    "# hr worldview body",
  );
  adapter.inject("hr" as DomainSlug, "policies/leave.md", "# leave");
  adapter.inject(
    "company" as DomainSlug,
    "company.md",
    "# old company doc",
  );
  return adapter;
}

describe("SovereigntySpyWikiAdapter — sovereignty pin", () => {
  it("ALLOWS readPage(<non-aggregator>, 'worldview.md')", async () => {
    const inner = seedAdapter();
    const spy = new SovereigntySpyWikiAdapter({
      inner,
      aggregatorOwnSlug: "company",
    });
    const page = await spy.readPage(
      "exec" as DomainSlug,
      "worldview.md",
    );
    expect(page?.content).toBe("# exec worldview body");
  });

  it("REJECTS readPage(<non-aggregator>, <other-path>) with WorldviewSovereigntyError", async () => {
    const inner = seedAdapter();
    const spy = new SovereigntySpyWikiAdapter({
      inner,
      aggregatorOwnSlug: "company",
    });
    await expect(
      spy.readPage("exec" as DomainSlug, "team/eng.md"),
    ).rejects.toBeInstanceOf(WorldviewSovereigntyError);
  });

  it("REJECTS readPage from any non-aggregator domain on any non-worldview.md path", async () => {
    const inner = seedAdapter();
    const spy = new SovereigntySpyWikiAdapter({
      inner,
      aggregatorOwnSlug: "company",
    });
    for (const [slug, path] of [
      ["exec", "team/eng.md"],
      ["exec", "projects/q3.md"],
      ["hr", "policies/leave.md"],
    ] as const) {
      await expect(
        spy.readPage(slug as DomainSlug, path),
      ).rejects.toBeInstanceOf(WorldviewSovereigntyError);
    }
  });

  it("ALLOWS reads from the aggregator's OWN slug on any path (it owns its own pages)", async () => {
    const inner = seedAdapter();
    const spy = new SovereigntySpyWikiAdapter({
      inner,
      aggregatorOwnSlug: "company",
    });
    const page = await spy.readPage(
      "company" as DomainSlug,
      "company.md",
    );
    expect(page?.content).toBe("# old company doc");
  });

  it("WorldviewSovereigntyError carries errorClass='validation' (DLQ-routable)", async () => {
    const inner = seedAdapter();
    const spy = new SovereigntySpyWikiAdapter({
      inner,
      aggregatorOwnSlug: "company",
    });
    try {
      await spy.readPage("exec" as DomainSlug, "team/eng.md");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as WorldviewSovereigntyError).errorClass).toBe(
        "validation",
      );
      expect((err as WorldviewSovereigntyError).domainSlug).toBe("exec");
      expect((err as WorldviewSovereigntyError).attemptedPath).toBe(
        "team/eng.md",
      );
    }
  });

  it("violationLog records each rejection (test-friendly diagnostic)", async () => {
    const inner = seedAdapter();
    const spy = new SovereigntySpyWikiAdapter({
      inner,
      aggregatorOwnSlug: "company",
    });
    await expect(
      spy.readPage("exec" as DomainSlug, "team/eng.md"),
    ).rejects.toThrow();
    await expect(
      spy.readPage("hr" as DomainSlug, "policies/leave.md"),
    ).rejects.toThrow();
    expect(spy.violationLog).toEqual([
      { slug: "exec", path: "team/eng.md" },
      { slug: "hr", path: "policies/leave.md" },
    ]);
  });

  it("getHeadSha + listMarkdown + writeAtomic pass through unchanged", async () => {
    const inner = seedAdapter();
    const spy = new SovereigntySpyWikiAdapter({
      inner,
      aggregatorOwnSlug: "company",
    });
    expect(await spy.getHeadSha("exec" as DomainSlug)).toBeDefined();
    const paths = await spy.listMarkdown("exec" as DomainSlug);
    expect(paths.length).toBeGreaterThan(0);
  });
});
