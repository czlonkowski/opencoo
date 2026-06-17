import { describe, expect, it } from "vitest";

import { validatePageConformance } from "../../src/page-spec/validate.js";

const fm = (body: string, ...lines: string[]): string =>
  `---\n${lines.join("\n")}\n---\n${body}`;

describe("validatePageConformance — concept pages (OKF §9.1/§9.2)", () => {
  it("passes a non-reserved page with a non-empty type", () => {
    const r = validatePageConformance({
      path: "strategy/q3.md",
      content: fm("Body.", "type: Knowledge Page", "title: Q3"),
    });
    expect(r.conformant).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("fails a concept page with no frontmatter at all", () => {
    const r = validatePageConformance({
      path: "strategy/q3.md",
      content: "# Q3\n\nNo frontmatter here.\n",
    });
    expect(r.conformant).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("missing-frontmatter");
  });

  it("fails a concept page whose frontmatter lacks type", () => {
    const r = validatePageConformance({
      path: "strategy/q3.md",
      content: fm("Body.", "title: Q3"),
    });
    expect(r.conformant).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("missing-type");
  });

  it("fails a concept page with an empty type", () => {
    const r = validatePageConformance({
      path: "strategy/q3.md",
      content: fm("Body.", 'type: ""'),
    });
    expect(r.conformant).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("missing-type");
  });

  it("fails a concept page with unparseable frontmatter (no throw)", () => {
    const r = validatePageConformance({
      path: "strategy/q3.md",
      content: "---\nfoo: [unclosed\n---\nBody.\n",
    });
    expect(r.conformant).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("unparseable-frontmatter");
  });

  it("is permissive: unknown type, extra keys and broken links are conformant (OKF §9)", () => {
    const r = validatePageConformance({
      path: "strategy/q3.md",
      content: fm(
        "See [missing](/not/written/yet.md).",
        "type: SomethingNonStandard",
        "page_path: strategy/q3.md",
        "schema_version: 1.0.0",
        "weird_key: 42",
      ),
    });
    expect(r.conformant).toBe(true);
  });
});

describe("validatePageConformance — index.md (OKF §6/§11)", () => {
  it("passes a root index.md with no frontmatter", () => {
    const r = validatePageConformance({
      path: "index.md",
      content: "# Index\n\n## strategy/\n- strategy/q3.md\n",
    });
    expect(r.conformant).toBe(true);
  });

  it("passes a root index.md whose only frontmatter key is okf_version", () => {
    const r = validatePageConformance({
      path: "index.md",
      content: fm("# Index\n", 'okf_version: "0.1"'),
    });
    expect(r.conformant).toBe(true);
  });

  it("fails a root index.md with frontmatter keys beyond okf_version", () => {
    const r = validatePageConformance({
      path: "index.md",
      content: fm("# Index\n", 'okf_version: "0.1"', "type: Index"),
    });
    expect(r.conformant).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain(
      "index-frontmatter-not-okf-version",
    );
  });

  it("fails a nested index.md that carries any frontmatter", () => {
    const r = validatePageConformance({
      path: "strategy/index.md",
      content: fm("# Strategy\n", 'okf_version: "0.1"'),
    });
    expect(r.conformant).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("index-has-frontmatter");
  });

  it("fails a nested index.md with an empty frontmatter fence (OKF §6 — index files carry no frontmatter)", () => {
    const r = validatePageConformance({
      path: "strategy/index.md",
      content: "---\n---\n# Strategy\n",
    });
    expect(r.conformant).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("index-has-frontmatter");
  });

  it("passes a nested index.md with no frontmatter", () => {
    const r = validatePageConformance({
      path: "strategy/index.md",
      content: "# Strategy\n\n- strategy/q3.md\n",
    });
    expect(r.conformant).toBe(true);
  });
});

describe("validatePageConformance — log.md (OKF §7)", () => {
  it("passes a log.md with ISO date H2 headings", () => {
    const r = validatePageConformance({
      path: "log.md",
      content:
        "# Directory Update Log\n\n## 2026-05-22\n* **Update**: x\n\n## 2026-05-15\n* **Creation**: y\n",
    });
    expect(r.conformant).toBe(true);
  });

  it("fails a log.md with a non-ISO-date H2 heading", () => {
    const r = validatePageConformance({
      path: "log.md",
      content: "# Log\n\n## Recently\n* did stuff\n",
    });
    expect(r.conformant).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("log-bad-date-heading");
  });

  it("passes an empty log.md", () => {
    const r = validatePageConformance({ path: "log.md", content: "# Log\n" });
    expect(r.conformant).toBe(true);
  });
});
