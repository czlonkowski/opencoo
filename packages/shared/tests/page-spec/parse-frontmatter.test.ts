import { describe, expect, it } from "vitest";

import { parseFrontmatter } from "../../src/page-spec/parse-frontmatter.js";

// Hardened wrapper over gray-matter. The validator and source-okf both
// need to know three things about a page: is there a frontmatter fence,
// did the YAML parse, and what are the keys + body. gray-matter has a
// known footgun (it caches malformed input: first call throws, later
// calls silently return empty) — the wrapper must be deterministic.
describe("parseFrontmatter", () => {
  it("reports no frontmatter for a plain markdown body", () => {
    const raw = "# Hello\n\nSome body.\n";
    const r = parseFrontmatter(raw);
    expect(r.present).toBe(false);
    expect(r.parseable).toBe(true);
    expect(r.data).toEqual({});
    expect(r.body).toBe(raw);
  });

  it("parses a well-formed frontmatter block and returns the body", () => {
    const raw = "---\ntype: Playbook\ntitle: Incident response\n---\nStep 1.\n";
    const r = parseFrontmatter(raw);
    expect(r.present).toBe(true);
    expect(r.parseable).toBe(true);
    expect(r.data["type"]).toBe("Playbook");
    expect(r.data["title"]).toBe("Incident response");
    expect(r.body.trim()).toBe("Step 1.");
  });

  it("treats an empty frontmatter block as present and parseable with no keys", () => {
    const r = parseFrontmatter("---\n---\nBody.\n");
    expect(r.present).toBe(true);
    expect(r.parseable).toBe(true);
    expect(r.data).toEqual({});
  });

  it("flags malformed YAML frontmatter as unparseable without throwing", () => {
    const r = parseFrontmatter("---\nfoo: [unclosed\n---\nBody.\n");
    expect(r.present).toBe(true);
    expect(r.parseable).toBe(false);
  });

  it("is deterministic on malformed input despite gray-matter's input cache", () => {
    const raw = "---\nbar: {unclosed\n---\nBody.\n";
    const first = parseFrontmatter(raw);
    const second = parseFrontmatter(raw);
    expect(first.parseable).toBe(false);
    expect(second.parseable).toBe(false);
  });

  it("flags an unterminated frontmatter fence as unparseable", () => {
    const r = parseFrontmatter("---\ntype: X\nno closing fence\n");
    expect(r.present).toBe(true);
    expect(r.parseable).toBe(false);
  });
});
