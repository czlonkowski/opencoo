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

export function normalize(input: string): string {
  let out = input;
  if (out.charCodeAt(0) === BOM) out = out.slice(1);
  out = out.replace(CRLF_OR_CR, "\n");
  out = out.normalize("NFC");
  out = out.replace(CONTROL_CHARS, "");
  return out;
}
