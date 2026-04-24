/**
 * Numeric-checksum validators used to filter shape-positive but
 * content-negative regex matches. The regex engine cheaply finds
 * candidates (11-digit run, 16-digit run, IBAN-shape) and the
 * validator decides whether the candidate is structurally a real
 * identifier — which keeps false-positive rates low without making
 * the regexes themselves catastrophic.
 *
 * Each function is pure, takes the candidate string ALREADY stripped
 * of separators (or in IBAN's case the raw alphanumeric run), and
 * returns boolean. Never throws.
 */

// ---------------------------------------------------------------------------
// PESEL — Polish national ID (11 digits)
// ---------------------------------------------------------------------------

/**
 * Validate a PESEL by its weighted-sum checksum. Weights are the
 * canonical [1, 3, 7, 9, 1, 3, 7, 9, 1, 3] over digits 1-10; the
 * 11th digit is the check digit such that
 *   (10 - sum % 10) % 10 === check
 * is satisfied.
 */
const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3] as const;

export function isValidPesel(candidate: string): boolean {
  if (!/^\d{11}$/.test(candidate)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = candidate[i];
    if (ch === undefined) return false;
    const w = PESEL_WEIGHTS[i];
    if (w === undefined) return false;
    sum += Number(ch) * w;
  }
  const check = Number(candidate[10]);
  if (Number.isNaN(check)) return false;
  return (10 - (sum % 10)) % 10 === check;
}

// ---------------------------------------------------------------------------
// NIP — Polish tax ID (10 digits)
// ---------------------------------------------------------------------------

const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7] as const;

export function isValidNip(candidate: string): boolean {
  if (!/^\d{10}$/.test(candidate)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const ch = candidate[i];
    if (ch === undefined) return false;
    const w = NIP_WEIGHTS[i];
    if (w === undefined) return false;
    sum += Number(ch) * w;
  }
  const check = Number(candidate[9]);
  if (Number.isNaN(check)) return false;
  return sum % 11 === check;
}

// ---------------------------------------------------------------------------
// REGON — Polish company ID (9 or 14 digits)
// ---------------------------------------------------------------------------

const REGON_9_WEIGHTS = [8, 9, 2, 3, 4, 5, 6, 7] as const;
const REGON_14_WEIGHTS = [2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8] as const;

export function isValidRegon(candidate: string): boolean {
  if (candidate.length === 9 && /^\d{9}$/.test(candidate)) {
    let sum = 0;
    for (let i = 0; i < 8; i++) {
      const ch = candidate[i];
      const w = REGON_9_WEIGHTS[i];
      if (ch === undefined || w === undefined) return false;
      sum += Number(ch) * w;
    }
    const check = Number(candidate[8]);
    if (Number.isNaN(check)) return false;
    const computed = sum % 11;
    return (computed === 10 ? 0 : computed) === check;
  }
  if (candidate.length === 14 && /^\d{14}$/.test(candidate)) {
    // 14-digit REGON: first 9 must self-validate, then the 14-digit
    // weights apply over digits 1-13 with check at 14.
    if (!isValidRegon(candidate.slice(0, 9))) return false;
    let sum = 0;
    for (let i = 0; i < 13; i++) {
      const ch = candidate[i];
      const w = REGON_14_WEIGHTS[i];
      if (ch === undefined || w === undefined) return false;
      sum += Number(ch) * w;
    }
    const check = Number(candidate[13]);
    if (Number.isNaN(check)) return false;
    const computed = sum % 11;
    return (computed === 10 ? 0 : computed) === check;
  }
  return false;
}

// ---------------------------------------------------------------------------
// IBAN — MOD-97 over the rearranged alphanumeric form
// ---------------------------------------------------------------------------

/**
 * Validate an IBAN per ISO 13616:
 *   1. Move the first four characters (country code + check digits) to
 *      the end.
 *   2. Replace each letter with its numeric value (A=10 … Z=35).
 *   3. The resulting BigInt mod 97 must equal 1.
 *
 * Length is country-specific (15-34); we only enforce the 15-34 bound
 * up front and let the MOD-97 check do the heavy lifting. Uses BigInt
 * so we never lose precision on the 34-digit form.
 */
export function isValidIban(candidate: string): boolean {
  const trimmed = candidate.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(trimmed)) return false;
  const rearranged = trimmed.slice(4) + trimmed.slice(0, 4);
  let numeric = "";
  for (const ch of rearranged) {
    if (ch >= "0" && ch <= "9") {
      numeric += ch;
    } else if (ch >= "A" && ch <= "Z") {
      numeric += String(ch.charCodeAt(0) - 55); // A=10 … Z=35
    } else {
      return false;
    }
  }
  // BigInt MOD-97 — JS Number can't carry the full digit run safely.
  try {
    return BigInt(numeric) % 97n === 1n;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Luhn — credit cards (13-19 digits)
// ---------------------------------------------------------------------------

export function isValidLuhn(candidate: string): boolean {
  if (!/^\d{13,19}$/.test(candidate)) return false;
  let sum = 0;
  let alt = false;
  for (let i = candidate.length - 1; i >= 0; i--) {
    const ch = candidate[i];
    if (ch === undefined) return false;
    let n = Number(ch);
    if (Number.isNaN(n)) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
