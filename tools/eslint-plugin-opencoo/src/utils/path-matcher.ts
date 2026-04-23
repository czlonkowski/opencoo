/**
 * Tiny, dependency-free glob → RegExp for the rule allow-list patterns.
 * Supports `**` (any number of path segments including zero), `*` (any
 * chars except `/`), and `?` (one char except `/`). Paths are normalised
 * to forward slashes before matching; the comparison is suffix-anchored:
 * the pattern matches if any suffix of the normalised path satisfies it.
 * This lets rules be passed short repo-relative globs (e.g.
 * `packages/shared/wiki-write/**`) without knowing a test's sandbox root.
 */

function globToRegexSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === undefined) break;

    if (ch === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        // `**/` — zero or more path segments including none
        const afterStars = pattern[i + 2];
        if (afterStars === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
          continue;
        }
        // `**` at end or before non-slash — match any chars including slashes
        out += ".*";
        i += 2;
        continue;
      }
      // single `*` — any number of non-slash chars
      out += "[^/]*";
      i += 1;
      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }

    // regex meta-characters need escaping
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += "\\" + ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

function globToRegex(pattern: string): RegExp {
  return new RegExp(`(?:^|/)${globToRegexSource(pattern)}$`);
}

const cache = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  let compiled = cache.get(pattern);
  if (compiled === undefined) {
    compiled = globToRegex(pattern);
    cache.set(pattern, compiled);
  }
  return compiled;
}

export function pathMatchesAny(
  filename: string,
  patterns: readonly string[],
): boolean {
  const normalised = filename.replace(/\\/g, "/");
  return patterns.some((p) => compile(p).test(normalised));
}
