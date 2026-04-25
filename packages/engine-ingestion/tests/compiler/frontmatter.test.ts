/**
 * `buildFrontmatter` — synthesises the YAML frontmatter block
 * the compiler prepends to every page body before passing the
 * full string to wikiWrite.
 *
 * Q5: schema_version is hardcoded '1.0.0' in this PR. Promote
 * to @opencoo/shared/page-spec when Lint/Heartbeat (PR 17+)
 * also need to read it.
 */
import { describe, expect, it } from "vitest";

import { buildFrontmatter } from "../../src/compiler/frontmatter.js";

describe("buildFrontmatter — shape", () => {
  it("emits a fenced YAML block delimited by --- on its own lines", () => {
    const out = buildFrontmatter({
      title: "Q3 Strategy",
      pagePath: "strategy/q3-2026.md",
      domainSlug: "test-domain",
      compiledAt: new Date("2026-04-25T12:00:00Z"),
      promptVersion: "1.0.0",
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("---");
    // Ends with a `---` line followed by a single trailing newline.
    expect(out.endsWith("---\n")).toBe(true);
  });

  it("includes title, page_path, domain_slug, compiled_at, prompt_version, schema_version", () => {
    const out = buildFrontmatter({
      title: "Q3 Strategy",
      pagePath: "strategy/q3-2026.md",
      domainSlug: "test-domain",
      compiledAt: new Date("2026-04-25T12:00:00Z"),
      promptVersion: "1.0.0",
    });
    expect(out).toContain("title: Q3 Strategy");
    expect(out).toContain("page_path: strategy/q3-2026.md");
    expect(out).toContain("domain_slug: test-domain");
    expect(out).toContain("compiled_at: 2026-04-25T12:00:00.000Z");
    expect(out).toContain("prompt_version: 1.0.0");
    expect(out).toContain("schema_version: 1.0.0");
  });

  it("YAML-quotes title strings that contain special characters", () => {
    const out = buildFrontmatter({
      title: "Q3: roadmap & priorities",
      pagePath: "strategy/x.md",
      domainSlug: "d",
      compiledAt: new Date(0),
      promptVersion: "1.0.0",
    });
    // Colons, ampersands, leading whitespace, etc. must be quoted
    // or escaped; the simplest safe choice is to always quote.
    expect(out).toContain('title: "Q3: roadmap & priorities"');
  });

  it("escapes embedded double-quotes in title via backslash", () => {
    const out = buildFrontmatter({
      title: 'has "quotes" inside',
      pagePath: "strategy/x.md",
      domainSlug: "d",
      compiledAt: new Date(0),
      promptVersion: "1.0.0",
    });
    expect(out).toContain('title: "has \\"quotes\\" inside"');
  });

  it("rejects empty title (caller bug)", () => {
    expect(() =>
      buildFrontmatter({
        title: "",
        pagePath: "strategy/x.md",
        domainSlug: "d",
        compiledAt: new Date(0),
        promptVersion: "1.0.0",
      }),
    ).toThrow();
  });

  it("rejects title containing newline (would break YAML)", () => {
    expect(() =>
      buildFrontmatter({
        title: "line one\nline two",
        pagePath: "strategy/x.md",
        domainSlug: "d",
        compiledAt: new Date(0),
        promptVersion: "1.0.0",
      }),
    ).toThrow();
  });
});

describe("buildFrontmatter — schema_version pin", () => {
  it("schema_version is '1.0.0' regardless of input (Q5: hardcoded for v0.1)", () => {
    const out = buildFrontmatter({
      title: "x",
      pagePath: "strategy/x.md",
      domainSlug: "d",
      compiledAt: new Date(0),
      promptVersion: "9.9.9",
    });
    expect(out).toContain("schema_version: 1.0.0");
  });
});
