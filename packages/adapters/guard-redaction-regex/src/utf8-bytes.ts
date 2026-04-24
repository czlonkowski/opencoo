/**
 * Utilities to translate between JS-string code-unit offsets (UTF-16,
 * 16-bit code units) and UTF-8 byte offsets. The `redaction_events`
 * schema stores `matched_byte_ranges` in UTF-8 byte units (the
 * intake on disk is bytes), so the adapter must convert from
 * `RegExp.exec`'s 16-bit offsets when populating events.
 *
 * Implementation is a single forward pass that builds a mapping
 * [codeUnitOffset → byteOffset] over the input string. Using
 * `Buffer.byteLength(slice)` once per match would be O(n²) worst-case
 * across many matches; the forward-pass map is O(n) per classify call
 * and amortises across all matches.
 */

/**
 * Build the prefix-byte-length map for `text`. `byteOffsetAt(i)`
 * returns the UTF-8 byte length of `text.slice(0, i)`. Index 0 is
 * always 0; index `text.length` is the total byte length.
 */
export function buildByteOffsetMap(text: string): Uint32Array {
  // +1 so the final index gives the total byte length of the string.
  const out = new Uint32Array(text.length + 1);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    out[i] = bytes;
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — count as 4 bytes ONLY if a low surrogate
      // follows; otherwise it's a stray (treat as 3-byte replacement
      // to match Buffer.from(s, 'utf8') behaviour for unpaired
      // surrogates, which encodes them as the U+FFFD replacement).
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4; // valid surrogate pair
        // Skip the low surrogate — its `out` slot still gets filled
        // by the next iteration; see the 0xdc00-0xdfff branch below
        // which adds 0 (it's already accounted for).
      } else {
        bytes += 3;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate — already counted by the preceding high
      // surrogate iteration when it found a valid pair. If the
      // preceding char wasn't a valid high surrogate, this is a
      // stray; emit 3 bytes to match Buffer's replacement
      // behaviour.
      const prev = i > 0 ? text.charCodeAt(i - 1) : 0;
      if (prev >= 0xd800 && prev <= 0xdbff) {
        bytes += 0;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  out[text.length] = bytes;
  return out;
}

/**
 * Convert a single (start, end) code-unit pair to (start, end) UTF-8
 * byte offsets via a pre-built map.
 */
export function codeUnitsToBytes(
  map: Uint32Array,
  start: number,
  end: number,
): { start: number; end: number } {
  return {
    start: map[start] ?? 0,
    end: map[end] ?? 0,
  };
}
