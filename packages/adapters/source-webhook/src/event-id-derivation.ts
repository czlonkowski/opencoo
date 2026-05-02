/**
 * Jsonpath event-id extraction for the generic webhook adapter (PR-I).
 *
 * Implements a minimal jsonpath parser sufficient for the patterns
 * we expect in practice:
 *   - `$.event.id`
 *   - `$.payload.event_id`
 *   - `$.id`
 *
 * Does NOT implement the full jsonpath spec (filters, wildcards,
 * recursive descent). If a future adapter needs those, pull in a
 * library. The mini-parser here stays zero-dep and easily auditable.
 *
 * THREAT-MODEL §3.1 (replay-stable event_id):
 * Extraction failure throws ValidationError so the receiver fails
 * closed — a payload without a derivable event_id is not ingested.
 * This prevents replay-instability (two payloads with the same
 * derived id would collide in the webhook_events UNIQUE index).
 */
import { ValidationError } from "@opencoo/shared/errors";

/**
 * Extract a scalar value (string | number) from `obj` using the
 * jsonpath `path`. Only dot-notation paths starting with `$` are
 * supported.
 *
 * Returns `undefined` when any segment in the path is absent.
 * Throws `ValidationError` on path syntax errors.
 *
 * NEVER throws `WebhookSignatureError` or leaks secret bytes —
 * only shape-of-path errors surface here (THREAT-MODEL §3.6 inv 11).
 */
export function extractJsonPath(
  obj: unknown,
  path: string,
): string | number | undefined {
  if (!path.startsWith("$")) {
    throw new ValidationError(
      `source-webhook: eventIdField must start with '$' (got '${path}')`,
    );
  }

  // Strip the leading '$' and split on '.', skipping empty segments.
  const segments = path
    .slice(1)
    .split(".")
    .filter((s) => s.length > 0);

  let current: unknown = obj;

  for (const segment of segments) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    // Safe: we verified `current` is a non-null object.
    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current === "string" || typeof current === "number") {
    return current;
  }
  return undefined;
}

/**
 * Extract the event_id string from a parsed payload using the
 * adapter's `eventIdField` jsonpath. Throws ValidationError when
 * the path resolves to nothing — fail-closed to prevent
 * replay-instability (no id = no idempotency key = no dedup).
 *
 * THREAT-MODEL §3.1: deterministic event_id is the replay-safety
 * anchor for the `webhook_events` UNIQUE (binding_id, event_id)
 * constraint.
 */
export function deriveEventId(
  payload: unknown,
  eventIdField: string,
): string {
  const value = extractJsonPath(payload, eventIdField);
  if (value === undefined || value === null) {
    throw new ValidationError(
      `source-webhook: could not extract event_id using jsonpath '${eventIdField}' — field absent or not a scalar. Refusing to ingest (fail-closed for replay safety).`,
    );
  }
  return String(value);
}
