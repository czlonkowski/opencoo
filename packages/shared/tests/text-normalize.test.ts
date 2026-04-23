import { describe, expect, it } from "vitest";

import { normalize } from "../src/text-normalize.js";

// Helper: assert that `normalize` is idempotent for a given input.
// One round-trip must equal two round-trips. Catches partial passes
// (e.g. if trimming introduces a state the next pass would re-trim).
function expectIdempotent(input: string): void {
  const once = normalize(input);
  const twice = normalize(once);
  expect(twice).toBe(once);
}

describe("normalize — identity and empty", () => {
  it("returns '' for ''", () => {
    expect(normalize("")).toBe("");
  });

  it("is idempotent on empty string", () => {
    expectIdempotent("");
  });

  it("returns plain ASCII text unchanged", () => {
    expect(normalize("hello world")).toBe("hello world");
  });
});

describe("normalize — BOM", () => {
  it("strips a leading U+FEFF BOM", () => {
    expect(normalize("﻿hi")).toBe("hi");
  });

  it("preserves a non-leading BOM (it's just a zero-width joiner mid-stream)", () => {
    const input = "a﻿b";
    expect(normalize(input)).toBe(input);
  });

  it("is idempotent with BOM", () => {
    expectIdempotent("﻿hi");
  });
});

describe("normalize — line endings", () => {
  it("converts CRLF to LF", () => {
    expect(normalize("a\r\nb")).toBe("a\nb");
  });

  it("converts lone CR to LF", () => {
    expect(normalize("a\rb")).toBe("a\nb");
  });

  it("leaves LF untouched", () => {
    expect(normalize("a\nb")).toBe("a\nb");
  });

  it("handles mixed endings", () => {
    expect(normalize("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("is idempotent on line-ending variants", () => {
    expectIdempotent("a\r\nb\rc\nd");
  });
});

describe("normalize — NFC unicode composition", () => {
  it("composes decomposed é (U+0065 U+0301) to precomposed (U+00E9)", () => {
    const decomposed = "café";
    const result = normalize(decomposed);
    expect(result).toBe("café");
    expect([...result]).toHaveLength(4);
  });

  it("leaves already-composed text untouched", () => {
    expect(normalize("café")).toBe("café");
  });
});

describe("normalize — control characters", () => {
  it("strips C0 controls (except \\n and \\t)", () => {
    expect(normalize("ab\x00cd\x01")).toBe("abcd");
    expect(normalize("a\x07b")).toBe("ab");
  });

  it("keeps \\t", () => {
    expect(normalize("a\tb")).toBe("a\tb");
  });

  it("keeps \\n", () => {
    expect(normalize("a\nb")).toBe("a\nb");
  });

  it("strips DEL (U+007F)", () => {
    expect(normalize("a\x7Fb")).toBe("ab");
  });

  it("strips C1 controls (U+0080..U+009F)", () => {
    expect(normalize("a\x80b\x9Fc")).toBe("abc");
  });
});

describe("normalize — whitespace collapse (outside fence)", () => {
  it("collapses a run of interior spaces to one", () => {
    expect(normalize("a    b")).toBe("a b");
  });

  it("collapses mixed tab/space runs to one space", () => {
    expect(normalize("a \t b")).toBe("a b");
  });

  it("trims trailing whitespace", () => {
    expect(normalize("hello   \nworld")).toBe("hello\nworld");
  });

  it("trims trailing tabs", () => {
    expect(normalize("hello\t\t")).toBe("hello");
  });
});

describe("normalize — leading whitespace preservation (REVISED rule)", () => {
  it("preserves leading spaces on a Markdown list item", () => {
    expect(normalize("  - x")).toBe("  - x");
  });

  it("preserves 4-space indented (nested) list body", () => {
    expect(normalize("    nested")).toBe("    nested");
  });

  it("preserves leading tabs", () => {
    expect(normalize("\thello")).toBe("\thello");
  });

  it("preserves nested list structure", () => {
    const md = "- outer\n  - inner\n    - deeper";
    expect(normalize(md)).toBe(md);
  });

  it("preserves leading but collapses interior", () => {
    expect(normalize("  a    b   c")).toBe("  a b c");
  });
});

describe("normalize — blank-line cap", () => {
  it("caps three+ consecutive blank lines at two (one blank line)", () => {
    expect(normalize("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("preserves a single blank line", () => {
    expect(normalize("a\n\nb")).toBe("a\n\nb");
  });

  it("caps after a longer run", () => {
    expect(normalize("a\n\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("is idempotent for blank-line cap", () => {
    expectIdempotent("a\n\n\n\nb");
  });
});

describe("normalize — fenced code blocks", () => {
  it("preserves interior whitespace inside a ``` fence", () => {
    const input = "```py\n  x   =   1  \n```";
    expect(normalize(input)).toBe(input);
  });

  it("preserves interior whitespace inside a ~~~ fence", () => {
    const input = "~~~js\nif ( a   ===   b ) { }\n~~~";
    expect(normalize(input)).toBe(input);
  });

  it("collapses around a fence but not within", () => {
    const input = "before    x\n```\n  in  side  \n```\nafter    y";
    const expected = "before x\n```\n  in  side  \n```\nafter y";
    expect(normalize(input)).toBe(expected);
  });

  it("accepts a fence with up to 3 leading spaces", () => {
    const input = "   ```\n  body  \n   ```";
    expect(normalize(input)).toBe(input);
  });

  it("does NOT treat 4-space-indented ``` as a fence (Markdown rule)", () => {
    // 4+ leading spaces means indented code block, not fence.
    // Per the README restriction we do not preserve indented blocks;
    // the body collapses normally.
    const input = "    ```\n    a   b\n    ```";
    // Leading 4 spaces preserved; interior run collapsed.
    expect(normalize(input)).toBe("    ```\n    a b\n    ```");
  });

  it("requires close count >= open count", () => {
    // Open with 4 backticks; a 3-backtick line does NOT close it.
    const input = "````\nstill  inside  ```\ncloser  ```\n````";
    // Inside content passes verbatim; only the final 4-backtick line is the closer.
    expect(normalize(input)).toBe(input);
  });

  it("leaves content verbatim when a fence is unclosed at EOF", () => {
    const input = "```py\nx   =   1\n  still  going";
    expect(normalize(input)).toBe(input);
  });

  it("opens and closes with matching char-type (backtick vs tilde)", () => {
    // A tilde line does NOT close a backtick fence.
    const input = "```\n  x   =   1  \n~~~\n  y   =   2  \n```";
    // Everything between the first ``` and the second ``` passes verbatim.
    expect(normalize(input)).toBe(input);
  });
});

describe("normalize — idempotency sweep", () => {
  const cases: ReadonlyArray<{ name: string; input: string }> = [
    { name: "empty", input: "" },
    { name: "ascii", input: "hello" },
    { name: "BOM", input: "﻿hi" },
    { name: "mixed line endings", input: "a\r\nb\rc\n" },
    { name: "nfc decomposed", input: "café" },
    { name: "controls", input: "ab\x00c\x01" },
    { name: "interior run", input: "a    b" },
    { name: "nested list", input: "- a\n  - b\n    - c" },
    { name: "many blank lines", input: "a\n\n\n\nb" },
    { name: "fence", input: "```py\n  x   =   1  \n```" },
    { name: "unclosed fence", input: "```\nfoo  bar\n  baz" },
    { name: "mixed fence-and-prose", input: "x   y\n```\n  inside  \n```\na   b" },
  ];
  for (const c of cases) {
    it(`is idempotent: ${c.name}`, () => {
      expectIdempotent(c.input);
    });
  }
});
