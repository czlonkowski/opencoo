import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validatePageConformance } from "../../src/page-spec/validate.js";

// Oracle: our validator must accept the OKF spec author's OWN bundles
// (vendored from GoogleCloudPlatform/knowledge-catalog, Apache-2.0 — see
// __fixtures__/okf/README.md). A failure here means our reading of the
// spec diverged from the reference, not that the bundles are wrong.
const here = dirname(fileURLToPath(import.meta.url));
const bundlesRoot = join(here, "__fixtures__", "okf");

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...walkMarkdown(abs));
    } else if (entry.toLowerCase().endsWith(".md") && entry !== "README.md") {
      out.push(abs);
    }
  }
  return out;
}

/** Path relative to its bundle root (strip the leading "<bundle>/"), so
 *  each bundle's own index.md is recognised as the bundle root. */
function bundleRelativePath(abs: string): string {
  const rel = relative(bundlesRoot, abs).split(sep).join("/");
  return rel.split("/").slice(1).join("/");
}

describe("OKF reference bundles (Google Knowledge Catalog, Apache-2.0)", () => {
  const files = walkMarkdown(bundlesRoot);

  it("vendored the crypto_bitcoin + ga4 concept files", () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  for (const abs of files) {
    const rel = relative(bundlesRoot, abs).split(sep).join("/");
    it(`accepts ${rel}`, () => {
      const content = readFileSync(abs, "utf8");
      const result = validatePageConformance({
        path: bundleRelativePath(abs),
        content,
      });
      expect(result.violations).toEqual([]);
      expect(result.conformant).toBe(true);
    });
  }
});
