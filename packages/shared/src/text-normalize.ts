// Canonical opencoo text normalization — applied ONCE at the router
// edge when a document's bytes first arrive in the engine. Idempotent
// by construction (each step is either a fixed-point or NFC) so a
// second pass over already-normalized text is a no-op.
//
// Pipeline order:
//   1. BOM strip             — leading U+FEFF only
//   2. Line-ending normalize — CRLF and lone CR → LF
//   3. NFC                   — Unicode canonical composition
//   4. Control-strip         — C0/C1 except \n and \t
//   5. Whitespace collapse   — fence-aware; leading preserved; see below
//   6. Blank-line cap        — 3+ LFs → 2 LFs

const BOM = 0xfeff;
const CRLF_OR_CR = /\r\n?/g;
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

// Leading-preserving whitespace collapse. Split into leading
// indentation (spaces/tabs) + body; collapse any run of interior
// horizontal whitespace to one space; trim trailing horizontal
// whitespace. Preserving the leading run is what keeps nested
// Markdown lists readable (`  - outer\n    - inner` stays as-is).
const LEADING = /^([ \t]*)(.*)$/;
const HORIZONTAL_WS_RUN = /[ \t]+/g;
const TRAILING_HORIZONTAL_WS = /[ \t]+$/;
const THREE_OR_MORE_NEWLINES = /\n{3,}/g;

// CommonMark fenced code block rule: a line with 0-3 leading spaces
// followed by ≥3 consecutive backticks or tildes opens a fence. A
// close is a same-char-type fence with count ≥ the opener, again
// with 0-3 leading spaces. 4+ leading spaces makes the line an
// indented code block, not a fence — we do NOT preserve indented
// blocks (documented restriction; converters must emit fenced).
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})/;

type FenceChar = "`" | "~";

interface FenceState {
  readonly char: FenceChar;
  readonly minLen: number;
}

function fenceOpenerOf(line: string): FenceState | null {
  const m = FENCE_OPEN.exec(line);
  if (m === null) return null;
  const run = m[2] ?? "";
  const char = run.charAt(0);
  if (char !== "`" && char !== "~") return null;
  return { char, minLen: run.length };
}

function isFenceCloser(line: string, state: FenceState): boolean {
  // `state.char` is a literal `` ` `` or `~` by type — safe to
  // interpolate into the regex without further quoting.
  const re = new RegExp(`^ {0,3}${state.char}{${state.minLen},}\\s*$`);
  return re.test(line);
}

function collapseLine(line: string): string {
  const m = LEADING.exec(line);
  const lead = m?.[1] ?? "";
  const body = (m?.[2] ?? "").replace(HORIZONTAL_WS_RUN, " ");
  return (lead + body).replace(TRAILING_HORIZONTAL_WS, "");
}

function collapseWithFences(input: string): string {
  const lines = input.split("\n");
  let state: FenceState | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (state === null) {
      const opener = fenceOpenerOf(line);
      if (opener !== null) {
        // Fence-opener lines are passed through verbatim — leading
        // indentation (0-3 spaces) and the fence run matter to
        // downstream Markdown renderers.
        state = opener;
        continue;
      }
      lines[i] = collapseLine(line);
    } else if (isFenceCloser(line, state)) {
      // Closer line survives verbatim; exit fence state.
      state = null;
    }
    // else: inside a fence, line is passed through verbatim.
  }

  return lines.join("\n");
}

export function normalize(input: string): string {
  let out = input;
  if (out.charCodeAt(0) === BOM) out = out.slice(1);
  out = out.replace(CRLF_OR_CR, "\n");
  out = out.normalize("NFC");
  out = out.replace(CONTROL_CHARS, "");

  out = collapseWithFences(out);

  out = out.replace(THREE_OR_MORE_NEWLINES, "\n\n");
  return out;
}
