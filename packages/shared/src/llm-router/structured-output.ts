// Structured-output helpers for the LLM router.
//
// Pure functions (no `@ai-sdk/*` imports) supporting `generateObject`'s
// extract → validate → repair-retry loop. Real models frequently wrap
// JSON in markdown fences or surround it with prose; a strict
// `JSON.parse(text)` then rejects output that is *semantically* fine.
// `extractJsonCandidate` recovers the JSON; `buildRepairPrompt` lets
// the router re-ask the model with the validation error in context;
// `isRetryableProviderError` distinguishes a transient upstream blip
// (retry) from a genuine contract breach (DLQ).

import { ZodError } from "zod";

// Stable preamble injected into a repair re-prompt. Exported so tests
// (and the router) can reference it without string-duplication.
export const REPAIR_INSTRUCTION =
  "Your previous response did NOT conform to the required JSON schema. " +
  "Return ONLY a single valid JSON value that satisfies the schema — no prose, no markdown code fences.";

// Recover the most likely JSON payload from a model response:
//  1. strip a surrounding ```lang … ``` fence,
//  2. if the result is already a bare object/array, keep it,
//  3. otherwise slice from the first `{`/`[` to the matching last
//     `}`/`]` (handles leading/trailing prose).
// Best-effort: text with no JSON delimiters is returned trimmed, so the
// caller's `JSON.parse` produces the real diagnostic.
export function extractJsonCandidate(text: string): string {
  let s = text.trim();

  const fence = /^```[^\n]*\n?([\s\S]*?)\n?```$/.exec(s);
  if (fence?.[1] !== undefined) {
    s = fence[1].trim();
  }

  if (s.startsWith("{") || s.startsWith("[")) {
    return s;
  }

  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  const starts = [firstObj, firstArr].filter((i) => i >= 0);
  if (starts.length === 0) {
    return s;
  }
  const start = Math.min(...starts);
  const close = s[start] === "{" ? "}" : "]";
  const end = s.lastIndexOf(close);
  if (end > start) {
    return s.slice(start, end + 1);
  }
  return s;
}

// True when an error from a provider `generate()` call is worth
// retrying: 5xx / 429 / 408 / 409 status codes, an explicit
// `isRetryable` flag (set by `@ai-sdk` `APICallError`), or a
// network-level failure. Unwraps one level of `cause`. Anything else
// (4xx auth/bad-request, schema mismatch) is treated as permanent.
export function isRetryableProviderError(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const e = err as {
    statusCode?: unknown;
    isRetryable?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  };

  if (typeof e.isRetryable === "boolean") {
    return e.isRetryable;
  }

  if (typeof e.statusCode === "number") {
    const s = e.statusCode;
    return s === 408 || s === 409 || s === 429 || s >= 500;
  }

  const text = `${typeof e.name === "string" ? e.name : ""} ${
    typeof e.message === "string" ? e.message : ""
  }`.toLowerCase();
  if (
    /fetch failed|econnreset|etimedout|enotfound|socket hang up|network|timeout/.test(
      text,
    )
  ) {
    return true;
  }

  if (e.cause !== undefined && e.cause !== err) {
    return isRetryableProviderError(e.cause);
  }
  return false;
}

// Compose a repair re-prompt: the original instruction, the model's
// non-conforming output, and the precise validation error.
export function buildRepairPrompt(
  originalPrompt: string,
  badOutput: string,
  errorMessage: string,
): string {
  return [
    originalPrompt,
    "",
    REPAIR_INSTRUCTION,
    "",
    "--- YOUR PREVIOUS (INVALID) RESPONSE ---",
    badOutput,
    "--- VALIDATION ERROR ---",
    errorMessage,
  ].join("\n");
}

// Render a schema/JSON error as a compact, single-line diagnostic that
// is safe to feed back to the model in a repair prompt.
export function formatSchemaError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
