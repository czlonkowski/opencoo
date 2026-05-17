/**
 * No-`transition: all` + no `box-shadow` sweep — PR-C5
 * (wave-16, phase-a appendix #16).
 *
 * W11's audit-fence: design system rejects depth via drop-shadow
 * and rejects "all" as a transition target. C5 pins both as a
 * source-level fence so a future edit that re-adds either is
 * caught at test time, not at design review.
 *
 * The sweep walks every component / route / lib source file
 * under packages/ui/src and parses both inline JSX styles and
 * imported CSS for the disallowed patterns. A small allow-list
 * covers `boxShadow: "none"` (an explicit clamp, not an
 * introduction) and comment / assertion lines.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UI_SRC = resolve(__dirname, "../../src");

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFiles(full));
    } else if (/\.(tsx?|css)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = listFiles(UI_SRC);

describe("transition: all — globally forbidden in @opencoo/ui sources", () => {
  it("never appears in any UI source file", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const body = readFileSync(f, "utf-8");
      // Match `transition: all` whether inline-styled or in CSS.
      if (/transition:\s*all\b/.test(body)) offenders.push(f);
      // Also catch the camelCase form in CSS-in-JS: `transition: "all …"`.
      if (/transition:\s*["']all\b/.test(body)) offenders.push(f);
      // And the explicit transitionProperty: "all" variant.
      if (/transitionProperty:\s*["']all["']/.test(body)) offenders.push(f);
    }
    expect(offenders, `transition: all found in:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("box-shadow — W11 audit fence", () => {
  it("never introduces a box-shadow value other than 'none' in UI sources", () => {
    const offenders: { file: string; match: string }[] = [];
    const lineRe = /(?:box-shadow|boxShadow)\s*:\s*([^,;\n}]+)/g;
    for (const f of FILES) {
      const body = readFileSync(f, "utf-8");
      const lines = body.split("\n");
      lines.forEach((line, idx) => {
        // Skip comment-only lines.
        if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) return;
        const re = new RegExp(lineRe.source, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(line))) {
          const value = m[1]!.trim().toLowerCase().replace(/["'`]/g, "");
          // Allow the `none` / empty variants — those are either
          // explicit clamps or test assertions reading the empty
          // default.
          if (value === "none" || value === "") continue;
          offenders.push({
            file: `${f}:${String(idx + 1)}`,
            match: line.trim(),
          });
        }
      });
    }
    expect(
      offenders,
      `box-shadow other than 'none' found:\n${offenders
        .map((o) => `${o.file}: ${o.match}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
