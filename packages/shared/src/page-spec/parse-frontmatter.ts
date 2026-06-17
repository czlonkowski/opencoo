/**
 * Hardened frontmatter parser, shared by the OKF conformance validator
 * (`./validate.ts`) and the `source-okf` adapter.
 *
 * Wraps gray-matter — the same parser `gitea-wiki-mcp-server` uses to
 * read pages — so "parseable frontmatter" here means exactly what the
 * agent-facing MCP consumer can read. gray-matter has a footgun: it
 * caches by input string, so a malformed block throws on the FIRST call
 * but silently returns `{ data: {}, content: raw }` on later calls. We
 * detect that case explicitly so the result is deterministic and a
 * malformed block is always reported `parseable: false`.
 */

import matter from "gray-matter";

export interface ParsedFrontmatter {
  /** A leading `---` fence was present. */
  readonly present: boolean;
  /** The YAML inside the fence parsed cleanly. Always true when absent. */
  readonly parseable: boolean;
  /** Parsed frontmatter keys ({} when absent or unparseable). */
  readonly data: Record<string, unknown>;
  /** Body below the frontmatter (the whole input when absent). */
  readonly body: string;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const hasFence = raw.startsWith("---\n") || raw.startsWith("---\r\n");
  if (!hasFence) {
    return { present: false, parseable: true, data: {}, body: raw };
  }
  try {
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    // Cache-poison / unterminated-fence detection: an empty parse whose
    // content is the untouched input means gray-matter either replayed a
    // cached throw or never found a closing fence. Either way the block
    // is not valid frontmatter.
    if (Object.keys(data).length === 0 && parsed.content === raw) {
      return { present: true, parseable: false, data: {}, body: raw };
    }
    return { present: true, parseable: true, data, body: parsed.content };
  } catch {
    return { present: true, parseable: false, data: {}, body: raw };
  }
}
