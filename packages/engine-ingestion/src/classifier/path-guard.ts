/**
 * `validateAllowedPath` — binding-level path guard for Classifier
 * output (THREAT-MODEL §3.4 / Q4).
 *
 * Two layers must pass:
 *   1. Shape: the path is a valid wiki path per
 *      `@opencoo/shared/wiki-write/validatePath` — lowercase ASCII,
 *      valid extension, no `..`, no leading `/`, no `wiki-` prefix,
 *      no control chars, etc.
 *   2. Glob: the path matches at least one of the binding's
 *      `allowed_paths` patterns under `picomatch`.
 *
 * Both layers run on every classifier-emitted path. Failure in
 * either is a fail-closed `validation` error — the orchestrator
 * surfaces it to the caller (Scanner pipeline, PR 16+) for DLQ
 * routing.
 *
 * Picomatch options:
 *   - `dot: false` (default) — patterns don't match dotfiles unless
 *     the pattern itself starts with `.`. We don't expect dotfiles
 *     in wiki repos and the validatePath shape guard rejects them
 *     anyway, but keeping picomatch's default is the safer choice.
 *   - `nocase: false` — paths are case-sensitive on disk
 *     (architecture's wiki convention); the shape guard already
 *     rejects uppercase, but matching mismatched case here would
 *     mask the shape-guard rejection in error messages.
 */

import picomatch from "picomatch";

import {
  validatePath as validateWikiPathShape,
} from "@opencoo/shared/wiki-write";

import { OpencooError, type OpencooErrorOptions } from "@opencoo/shared/errors";

export class ClassifierPathError extends OpencooError {
  readonly path: string;
  readonly allowedPaths: readonly string[];

  constructor(
    message: string,
    path: string,
    allowedPaths: readonly string[],
    options?: OpencooErrorOptions,
  ) {
    super(message, "validation", options);
    this.name = "ClassifierPathError";
    this.path = path;
    this.allowedPaths = [...allowedPaths];
  }
}

const PICOMATCH_OPTS = { dot: false, nocase: false } as const;

export function validateAllowedPath(
  path: string,
  allowedPaths: readonly string[],
): void {
  // Layer 1 — shape. Wrap any WikiPathError so the caller sees a
  // single `ClassifierPathError` type for every classifier-side
  // path failure; the underlying shape error is preserved as
  // `.cause` for diagnostics.
  try {
    validateWikiPathShape(path);
  } catch (err) {
    throw new ClassifierPathError(
      `path '${path}' failed wiki shape guard: ${err instanceof Error ? err.message : String(err)}`,
      path,
      allowedPaths,
      { cause: err },
    );
  }

  // Layer 2 — glob match. picomatch is the canonical glob library
  // (planner Q4); a path matches the binding when ANY pattern
  // accepts it. `.some` short-circuits on the first hit so we don't
  // compile every matcher when an earlier pattern already accepts.
  const matched = allowedPaths.some((p) => picomatch(p, PICOMATCH_OPTS)(path));
  if (!matched) {
    throw new ClassifierPathError(
      `path '${path}' does not match any allowed_paths glob (allowed: ${JSON.stringify(allowedPaths)})`,
      path,
      allowedPaths,
    );
  }
}
