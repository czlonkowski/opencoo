/**
 * StructureSignals extraction + v0.1 degradation heuristics.
 *
 * v0.1 ships exactly two degradation rules, named in the contract:
 *   - `xlsx-no-pipes`     — XLSX with zero `|` outside fenced code
 *   - `pptx-no-headings`  — PPTX with zero ATX headings
 *
 * Anything else (DOCX with no text, PDF with OCR artefacts, HTML with
 * only body-less boilerplate) is left `degraded: false` in v0.1 —
 * THREAT-MODEL §3.2 is explicit that the list is bounded and extending
 * it requires a code change + heuristic test. Do NOT add another rule
 * without a PR that documents it.
 */
import type {
  ConversionResult,
  StructureSignals,
  DegradationReason,
} from "@opencoo/shared/adapter-contract-tests/document-converter";

// MIME constants — kept local so callers don't need to string-match
// against the content-type catalog every time.
const MIME_XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MIME_PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// Fenced code block detector. Lines starting with ``` or ~~~ (with up
// to 3 leading spaces) open a fence; a same-char run of ≥ the opener
// closes it. Inside a fence, we don't count pipes or headings.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// ATX heading marker. Space after the `#` run keeps `#fragment` prose
// from counting as a heading.
const ATX_HEADING_RE = /^#{1,6}\s/;

// GFM table separator cell: optional leading/trailing colon (alignment)
// around a run of three-plus dashes. Used to detect "heading row
// immediately followed by separator row" = one table.
const SEPARATOR_CELL_RE = /^\s*:?-{3,}:?\s*$/;

interface CountedLines {
  readonly gfmPipes: number;
  readonly detectedHeadings: number;
  readonly detectedTables: number;
}

function countLines(markdown: string): CountedLines {
  const lines = markdown.split("\n");
  let inFence = false;
  let fenceChar: "`" | "~" | null = null;
  let gfmPipes = 0;
  let detectedHeadings = 0;
  let detectedTables = 0;
  let prevPipeLine: string | null = null;

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch !== null) {
      const run = fenceMatch[1] ?? "";
      const ch = run.charAt(0) === "`" ? "`" : "~";
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
        fenceChar = null;
      }
      prevPipeLine = null;
      continue;
    }
    if (inFence) {
      prevPipeLine = null;
      continue;
    }

    // Count `|` chars outside fences (for xlsx-no-pipes heuristic).
    for (const c of line) {
      if (c === "|") gfmPipes++;
    }

    if (ATX_HEADING_RE.test(line)) detectedHeadings++;

    // GFM table separator — split on `|`, verify every non-empty cell
    // matches the separator pattern. A one-col separator (`| --- |`)
    // produces two empty cells + one dash cell, so filter empties.
    if (prevPipeLine !== null && line.includes("|")) {
      const cells = line.split("|").filter((c) => c.length > 0);
      if (cells.length > 0 && cells.every((c) => SEPARATOR_CELL_RE.test(c))) {
        detectedTables++;
      }
    }
    prevPipeLine = line.includes("|") ? line : null;
  }

  return { gfmPipes, detectedHeadings, detectedTables };
}

// Discriminated union: when `degraded` is true, `degradationReason` is
// present and typed; when false, the field is absent (not just
// `undefined`). Matches `ConversionResult`'s `exactOptionalPropertyTypes`
// contract without requiring a non-null assertion at the use site.
type DegradationOutcome =
  | { readonly degraded: false }
  | { readonly degraded: true; readonly degradationReason: DegradationReason };

function detectDegradation(
  mimeType: string,
  signals: StructureSignals,
): DegradationOutcome {
  if (mimeType === MIME_XLSX && signals.gfmPipes === 0) {
    return { degraded: true, degradationReason: "xlsx-no-pipes" };
  }
  if (mimeType === MIME_PPTX && signals.detectedHeadings === 0) {
    return { degraded: true, degradationReason: "pptx-no-headings" };
  }
  return { degraded: false };
}

/**
 * Build a ConversionResult from scrubbed Markdown + the source mimeType.
 * The returned object omits `degradationReason` entirely when
 * `degraded === false` (required by exactOptionalPropertyTypes).
 */
export function buildResult(
  markdown: string,
  mimeType: string,
): ConversionResult {
  const counts = countLines(markdown);
  const signals: StructureSignals = {
    detectedTables: counts.detectedTables,
    gfmPipes: counts.gfmPipes,
    detectedHeadings: counts.detectedHeadings,
  };
  const degradation = detectDegradation(mimeType, signals);
  if (degradation.degraded) {
    return {
      markdown,
      structureSignals: signals,
      degraded: true,
      degradationReason: degradation.degradationReason,
    };
  }
  return {
    markdown,
    structureSignals: signals,
    degraded: false,
  };
}
