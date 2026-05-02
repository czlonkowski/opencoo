/**
 * Content-kind mapping for the generic webhook adapter (PR-I).
 *
 * Supports per-binding mapping of payload fields to content_kind
 * so one binding can carry multiple event shapes (e.g. an n8n flow
 * that POSTs both "campaign-snapshot" and "lint-finding" payloads
 * to the same URL maps each to a different content_kind via
 * `contentKindMap`).
 *
 * The `contentKindMap` is `Record<jsonpath, CONTENT_KIND>`. The
 * first key whose jsonpath extraction returns a non-undefined value
 * is used as the content_kind. If no key matches, `defaultContentKind`
 * is used.
 *
 * v0.1 semantics: keys in `contentKindMap` are treated as jsonpath
 * selectors (checked for field PRESENCE, not value equality). This
 * is the "is this path present?" routing model — sufficient for the
 * multi-shape use case without requiring a full expression evaluator.
 *
 * Example: `{ "$.workflow": "n8n-workflow", "$.transcript": "document" }`
 * means "if the payload has $.workflow, it's n8n-workflow; if it has
 * $.transcript, it's document."
 */

import type { ContentKind } from "@opencoo/shared/db";
import { CONTENT_KINDS } from "@opencoo/shared/db";
import { extractJsonPath } from "./event-id-derivation.js";

/**
 * Resolve the `content_kind` for a parsed payload by walking
 * `contentKindMap` in insertion order. Returns the first matching
 * kind, or `defaultContentKind` when nothing matches.
 *
 * A map entry "matches" when the jsonpath key extracts a non-undefined
 * value from the payload (field presence check).
 */
export function resolveContentKind(
  payload: unknown,
  contentKindMap: Record<string, string> | undefined,
  defaultContentKind: ContentKind,
): ContentKind {
  if (contentKindMap === undefined) return defaultContentKind;

  for (const [path, kind] of Object.entries(contentKindMap)) {
    try {
      const value = extractJsonPath(payload, path);
      if (value !== undefined) {
        // Validate that the mapped kind is in CONTENT_KINDS.
        if ((CONTENT_KINDS as readonly string[]).includes(kind)) {
          return kind as ContentKind;
        }
        // Unknown kind — skip this entry rather than throwing.
        // The operator-configured kind may reference a value not yet
        // in CONTENT_KINDS (forward-compat). Fall through to next entry.
      }
    } catch {
      // extractJsonPath may throw ValidationError for malformed paths.
      // Skip this entry — a bad path in contentKindMap is not fatal.
      continue;
    }
  }

  return defaultContentKind;
}
