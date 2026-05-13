/**
 * `assertBindingNotWildcardOnly` — fail-closed runtime guard for
 * binding `allowed_paths` (THREAT-MODEL §3.4, Q5).
 *
 * The Management UI (PR 29) rejects unsafe shapes at create-time.
 * The engine MUST refuse them at runtime too — a direct DB poke
 * or a future config-importer that bypasses the UI would otherwise
 * give a compromised classifier free rein over the whole domain.
 *
 * Rejected shapes (any one fails the entire list):
 *   - empty array  (no paths at all → nothing can ever be written;
 *                   distinguishable from undefined upstream so we
 *                   surface it as a config error, not silent skip)
 *   - bare wildcard "**"  (matches every path in the domain)
 *   - any "**\/foo" / "**\/foo.md" shape  (catches every parent
 *     directory — same blast radius as bare "**")
 *
 * Accepted shapes:
 *   - bounded prefix glob like "strategy/**"  (constrained subtree)
 *   - literal page paths like "index.md"  (exactly one file)
 *   - mixed lists of the above
 *
 * Originally lived at `packages/engine-ingestion/src/classifier/binding-guard.ts`.
 * PR-W1 (phase-a appendix #14) moved the definition into `@opencoo/shared`
 * so the admin-API POST/PATCH paths in `@opencoo/engine-self-operating`
 * can pre-validate the same shape without crossing the cross-engine
 * boundary (`opencoo/no-cross-engine-import`). The engine-ingestion
 * classifier subsystem re-exports `assertBindingNotWildcardOnly` +
 * `BindingConfigError` so existing imports (including the runtime
 * classifier call-site) keep working unchanged.
 */

import { OpencooError, type OpencooErrorOptions } from "../errors.js";

export class BindingConfigError extends OpencooError {
  readonly allowedPaths: readonly string[];

  constructor(
    message: string,
    allowedPaths: readonly string[],
    options?: OpencooErrorOptions,
  ) {
    super(message, "validation", options);
    this.name = "BindingConfigError";
    this.allowedPaths = [...allowedPaths];
  }
}

/**
 * Returns true when the pattern is a "wildcard-shaped" pattern that
 * fails the §3.4 test. Bounded prefix patterns like `foo/**` are
 * SAFE — the prefix anchors the match to a subtree.
 */
function isWildcardShape(pattern: string): boolean {
  if (pattern === "**") return true;
  // Any pattern that starts with `**/` matches every parent
  // directory in the domain — same blast radius as bare `**`.
  if (pattern.startsWith("**/")) return true;
  return false;
}

export function assertBindingNotWildcardOnly(
  allowedPaths: readonly string[],
): void {
  if (allowedPaths.length === 0) {
    throw new BindingConfigError(
      "binding.allowed_paths is empty — at least one specific glob is required",
      allowedPaths,
    );
  }
  for (const pattern of allowedPaths) {
    if (isWildcardShape(pattern)) {
      throw new BindingConfigError(
        `binding.allowed_paths contains wildcard-shaped pattern '${pattern}' — wildcard-only bindings are forbidden by THREAT-MODEL §3.4`,
        allowedPaths,
      );
    }
  }
}
