/**
 * GATE 3 SOURCE-GREP TEST (plan #102 / plan #120 / THREAT-MODEL
 * §2 invariant 7).
 *
 * Defense-in-depth on top of the type-level + schema-level
 * Gate 3 enforcements:
 *   - Type level: AutomationAdapter has no `activate()` method
 *     (engine-self-operating side); the n8n-mcp adapter's local
 *     `N8nLikeApi.createWorkflow` has no `active` parameter.
 *   - Schema level: BuilderOutput has no `activated` field;
 *     n8nMcpCredentialSchema has no activation field; the n8n
 *     workflow body schema pins `active: z.literal(false)`.
 *   - **This file**: source files of two packages (comments
 *     stripped) do NOT contain any of the activation-shape
 *     verbs `activate(d)?`, `enable(d)?`, `toggle(d)?`
 *     (case-insensitive). Catches the case where someone
 *     bypasses the type system via an inline SQL string, a
 *     fetch() call, or any other escape hatch — even one
 *     where the literal isn't exactly `'activated'`.
 *
 * Scoped paths (PR 25 / plan #120 added the second tree):
 *   1. `engine-self-operating/src/agents/builder/run.ts` —
 *      original target from PR 21 / plan #102.
 *   2. `packages/adapters/automation-n8n-mcp/src/**\/*.ts` —
 *      every TS file under the n8n-mcp adapter package's
 *      source tree.
 *
 * Failing this test means a future PR introduced an activation-
 * shape verb in code — STOP and review before approving.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER_RUN_PATH = resolve(
  HERE,
  "../../src/agents/builder/run.ts",
);
const N8N_MCP_SRC_DIR = resolve(
  HERE,
  "../../../adapters/automation-n8n-mcp/src",
);

const FORBIDDEN_VERB_REGEX = /activate(d)?|enable(d)?|toggle(d)?/;

function stripComments(source: string): string {
  // Token-aware comment strip — using the TS scanner. The prior
  // regex-based stripper would consume `//` sequences inside
  // string/template literals (e.g. URLs like `https://.../act`),
  // which created two failure modes: (a) comment-style content
  // inside a string could disappear from analysis (false
  // negative — a deliberate bypass), and (b) trailing `// foo`
  // text inside an unterminated string could corrupt the
  // tokenization of subsequent code. The scanner respects
  // string/template/regex literals natively.
  const scanner = ts.createScanner(
    ts.ScriptTarget.ESNext,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source,
  );
  const parts: string[] = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      // Preserve newlines so line numbers stay stable for any
      // failure messages that reference them.
      parts.push(scanner.getTokenText().replace(/[^\n]/g, ""));
    } else {
      parts.push(scanner.getTokenText());
    }
    token = scanner.scan();
  }
  return parts.join("");
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTs(p));
    } else if (entry.isFile() && p.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("Gate 3 source-grep — builder/run.ts (plan #102)", () => {
  it("contains no activate/enable/toggle verbs in executable code (case-insensitive, comments stripped)", () => {
    const source = readFileSync(BUILDER_RUN_PATH, "utf8");
    // Strip comments — they may legitimately reference Gate 3
    // by name (e.g. "manual activation only"). We only forbid
    // the literal in CODE.
    expect(stripComments(source).toLowerCase()).not.toMatch(
      FORBIDDEN_VERB_REGEX,
    );
  });

  it("does contain the legitimate 'deployWorkflow' adapter call (sanity)", () => {
    const source = readFileSync(BUILDER_RUN_PATH, "utf8");
    expect(source).toContain("deployWorkflow");
  });
});

describe("Gate 3 source-grep — automation-n8n-mcp src tree (plan #120)", () => {
  it("every src/**/*.ts file lacks activate/enable/toggle verbs in executable code", () => {
    const files = walkTs(N8N_MCP_SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const codeOnly = stripComments(readFileSync(f, "utf8"));
      expect(codeOnly.toLowerCase(), `forbidden verb in ${f}`).not.toMatch(
        FORBIDDEN_VERB_REGEX,
      );
    }
  });

  it("the literal `active: false` appears in exactly ONE place across the package src", () => {
    // The n8n-mcp body-build site is the single sanctioned
    // occurrence (the Zod schema's `z.literal(false)` does not
    // match this regex — that's deliberate). Adding a second
    // would route around the body-build site review and is
    // forbidden.
    const files = walkTs(N8N_MCP_SRC_DIR);
    let total = 0;
    const offenders: string[] = [];
    for (const f of files) {
      const m = stripComments(readFileSync(f, "utf8")).match(
        /active\s*:\s*false/g,
      );
      if (m && m.length > 0) {
        total += m.length;
        offenders.push(`${f}: ${m.length}`);
      }
    }
    expect(
      total,
      `expected exactly 1 match (body-build site) but saw ${total}: ${offenders.join(", ")}`,
    ).toBe(1);
  });
});
