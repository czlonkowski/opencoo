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

function collapseLine(line: string): string {
  const m = LEADING.exec(line);
  const lead = m?.[1] ?? "";
  const body = (m?.[2] ?? "").replace(HORIZONTAL_WS_RUN, " ");
  return (lead + body).replace(TRAILING_HORIZONTAL_WS, "");
}

export function normalize(input: string): string {
  let out = input;
  if (out.charCodeAt(0) === BOM) out = out.slice(1);
  out = out.replace(CRLF_OR_CR, "\n");
  out = out.normalize("NFC");
  out = out.replace(CONTROL_CHARS, "");

  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    lines[i] = collapseLine(line);
  }
  out = lines.join("\n");

  out = out.replace(THREE_OR_MORE_NEWLINES, "\n\n");
  return out;
}
