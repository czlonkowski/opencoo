/**
 * `buildFrontmatter` — synthesises the YAML frontmatter block
 * the compiler prepends to every page body before passing the
 * full string to wikiWrite.
 *
 * Q5: schema_version is hardcoded '1.0.0' in this PR. Promote
 * to @opencoo/shared/page-spec when Lint/Heartbeat (PR 17+)
 * also need to read it.
 *
 * OKF v0.1: every page carries a non-empty `type` (the spec's sole
 * required field) plus a `timestamp` (recommended) mirroring
 * `compiled_at`. See @opencoo/shared/page-spec.
 */
import { describe, expect, it } from "vitest";

import { buildFrontmatter } from "../../src/compiler/frontmatter.js";

describe("buildFrontmatter — shape", () => {
  it("emits a fenced YAML block delimited by --- on its own lines", () => {
    const out = buildFrontmatter({
      title: "Q3 Strategy",
      type: "Knowledge Page",
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
      type: "Knowledge Page",
      pagePath: "strategy/q3-2026.md",
      domainSlug: "test-domain",
      compiledAt: new Date("2026-04-25T12:00:00Z"),
      promptVersion: "1.0.0",
    });
    expect(out).toContain("title: Q3 Strategy");
    expect(out).toContain("page_path: strategy/q3-2026.md");
    expect(out).toContain("domain_slug: test-domain");
    // compiled_at matches the YAML implicit-date pattern, so the
    // broader fix in copilot #18 quotes it. Versions like "1.0.0"
    // are NOT implicit-typed (two dots disqualifies the numeric
    // pattern) and stay unquoted.
    expect(out).toContain('compiled_at: "2026-04-25T12:00:00.000Z"');
    expect(out).toContain("prompt_version: 1.0.0");
    expect(out).toContain("schema_version: 1.0.0");
  });

  it("YAML-quotes title strings that contain special characters", () => {
    const out = buildFrontmatter({
      title: "Q3: roadmap & priorities",
      type: "Knowledge Page",
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
      type: "Knowledge Page",
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
        type: "Knowledge Page",
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
        type: "Knowledge Page",
        pagePath: "strategy/x.md",
        domainSlug: "d",
        compiledAt: new Date(0),
        promptVersion: "1.0.0",
      }),
    ).toThrow();
  });
});

describe("buildFrontmatter — OKF type + timestamp (OKF v0.1 §4.1)", () => {
  it("emits a non-empty type line (OKF's sole required field)", () => {
    const out = buildFrontmatter({
      title: "x",
      type: "Knowledge Page",
      pagePath: "strategy/x.md",
      domainSlug: "d",
      compiledAt: new Date(0),
      promptVersion: "1.0.0",
    });
    expect(out).toContain("type: Knowledge Page");
  });

  it("rejects an empty type (caller bug — OKF requires a non-empty type)", () => {
    expect(() =>
      buildFrontmatter({
        title: "x",
        type: "",
        pagePath: "strategy/x.md",
        domainSlug: "d",
        compiledAt: new Date(0),
        promptVersion: "1.0.0",
      }),
    ).toThrow();
  });

  it("rejects a whitespace-only type (matches the OKF gate's trim semantics)", () => {
    expect(() =>
      buildFrontmatter({
        title: "x",
        type: "   ",
        pagePath: "strategy/x.md",
        domainSlug: "d",
        compiledAt: new Date(0),
        promptVersion: "1.0.0",
      }),
    ).toThrow();
  });

  it("quotes a type that contains YAML-special characters", () => {
    const out = buildFrontmatter({
      title: "x",
      type: "Report: Q3",
      pagePath: "strategy/x.md",
      domainSlug: "d",
      compiledAt: new Date(0),
      promptVersion: "1.0.0",
    });
    expect(out).toContain('type: "Report: Q3"');
  });

  it("emits an OKF `timestamp` mirroring compiled_at", () => {
    const out = buildFrontmatter({
      title: "x",
      type: "Knowledge Page",
      pagePath: "strategy/x.md",
      domainSlug: "d",
      compiledAt: new Date("2026-04-25T12:00:00Z"),
      promptVersion: "1.0.0",
    });
    expect(out).toContain('timestamp: "2026-04-25T12:00:00.000Z"');
  });
});

describe("buildFrontmatter — schema_version pin", () => {
  it("schema_version is '1.0.0' regardless of input (Q5: hardcoded for v0.1)", () => {
    const out = buildFrontmatter({
      title: "x",
      type: "Knowledge Page",
      pagePath: "strategy/x.md",
      domainSlug: "d",
      compiledAt: new Date(0),
      promptVersion: "9.9.9",
    });
    expect(out).toContain("schema_version: 1.0.0");
  });
});

describe("buildFrontmatter — YAML implicit-typing safety (copilot #18)", () => {
  // YAML 1.2 implicit typing turns unquoted scalars matching certain
  // patterns into non-strings. Downstream consumers (gray-matter,
  // js-yaml in the Lint pipeline) would parse `title: 2026` as int,
  // `title: true` as bool, `title: null` as null. Always-quote
  // scalars matching the implicit-type patterns to keep the field
  // a string end-to-end.

  it("quotes a pure-digit title to keep it a string", () => {
    const out = buildFrontmatter({
      title: "2026",
      type: "Knowledge Page",
      pagePath: "strategy/x.md",
      domainSlug: "d",
      compiledAt: new Date(0),
      promptVersion: "1.0.0",
    });
    expect(out).toContain('title: "2026"');
    expect(out).not.toMatch(/title: 2026\n/);
  });

  it("quotes a decimal-number title to keep it a string", () => {
    const out = buildFrontmatter({
      title: "3.14",
      type: "Knowledge Page",
      pagePath: "strategy/x.md",
      domainSlug: "d",
      compiledAt: new Date(0),
      promptVersion: "1.0.0",
    });
    expect(out).toContain('title: "3.14"');
  });

  it("quotes 'true' / 'false' / 'yes' / 'no' / 'on' / 'off' titles (case-insensitive)", () => {
    for (const word of ["true", "TRUE", "false", "yes", "No", "on", "OFF"]) {
      const out = buildFrontmatter({
        title: word,
        type: "Knowledge Page",
        pagePath: "strategy/x.md",
        domainSlug: "d",
        compiledAt: new Date(0),
        promptVersion: "1.0.0",
      });
      expect(out).toContain(`title: "${word}"`);
    }
  });

  it("quotes 'null' / '~' titles (YAML null keywords)", () => {
    for (const word of ["null", "NULL", "~"]) {
      const out = buildFrontmatter({
        title: word,
        type: "Knowledge Page",
        pagePath: "strategy/x.md",
        domainSlug: "d",
        compiledAt: new Date(0),
        promptVersion: "1.0.0",
      });
      expect(out).toContain(`title: "${word}"`);
    }
  });

  it("quotes a date-shaped title to keep it a string", () => {
    const out = buildFrontmatter({
      title: "2026-04-25",
      type: "Knowledge Page",
      pagePath: "strategy/x.md",
      domainSlug: "d",
      compiledAt: new Date(0),
      promptVersion: "1.0.0",
    });
    expect(out).toContain('title: "2026-04-25"');
  });

  it("does not double-quote a plain alphanumeric title (regression guard)", () => {
    const out = buildFrontmatter({
      title: "simple-title",
      type: "Knowledge Page",
      pagePath: "strategy/x.md",
      domainSlug: "d",
      compiledAt: new Date(0),
      promptVersion: "1.0.0",
    });
    expect(out).toContain("title: simple-title");
    expect(out).not.toContain('title: "simple-title"');
  });
});
