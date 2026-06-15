/**
 * v1 pattern catalog for the regex-redaction guard. 14 categories,
 * Polish-PII-biased (the design-partner PoC is Polish; v0.2 will add
 * EU + US categories with the same shape).
 *
 * Each entry is:
 *   - `category`: identifier the engine routes on (matches the
 *     `redaction_events.category` text value)
 *   - `regex`: bounded quantifiers only — no unbounded `*` / `+`,
 *     no nested groups with overlapping quantifiers. ReDoS surface
 *     is the reason for the 100KiB perf canary in the test suite.
 *   - `validate?`: optional checksum hook the matcher runs after a
 *     regex hit. A `false` result REJECTS the match (no event).
 *   - `failMode`: per-category disposition the engine honours when
 *     building `redaction_events.fail_mode`.
 *
 * Adding a category: extend the array, add a positive sample to the
 * adapter test's `knownMatches`, document the false-positive bound
 * in the README. Bump PATTERN_VERSION on the next ship cycle.
 *
 * The PATTERN_VERSION constant lives in adapter.ts so it's adjacent
 * to the consumer that stamps it onto every event.
 */
import {
  isValidIban,
  isValidLuhn,
  isValidNip,
  isValidPesel,
  isValidRegon,
} from "./checksums.js";

import type { GuardFailMode } from "@opencoo/shared/adapter-contract-tests/guard";

export interface PatternDef {
  readonly category: string;
  readonly regex: RegExp;
  readonly failMode: GuardFailMode;
  /** Run AFTER a regex hit. Receives the exact substring that
   *  matched. `true` keeps the event, `false` rejects it. */
  readonly validate?: (match: string) => boolean;
}

// All regexes carry the `g` flag so `RegExp.exec` returns successive
// matches via `lastIndex` advancement. The matcher resets `lastIndex`
// per classify call so the regex objects (frozen by `as const`) stay
// stateless across calls.

export const PATTERNS = [
  // ---------------------------------------------------------------
  // PII — personal identifiers
  // ---------------------------------------------------------------
  {
    category: "email",
    // RFC-light: bounded local part 1-64, domain 1-253, TLD 2-24.
    // Avoids the unbounded `+` of naive email regexes.
    regex: /[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,24}/g,
    failMode: "transform",
  },
  {
    category: "phone-pl",
    // Polish phone: optional +48 / 0048 / 48 prefix, then 9 digits in
    // optional 3-3-3 separators. Bounded total length keeps ReDoS-safe.
    // The leading `(?<!\d)` negative-lookbehind plus the trailing `\b`
    // anchor BOTH ends against adjacent digits, so a 9-digit *suffix*
    // of a longer run (e.g. a 16-digit upstream object id) no longer
    // matches — such a suffix previously got redacted, corrupting wiki
    // paths derived from the id and the ids inside links in page bodies.
    regex: /(?<!\d)(?:\+48|0048|48)?[\s\-]?\d{3}[\s\-]?\d{3}[\s\-]?\d{3}\b/g,
    failMode: "transform",
    validate: (m) => {
      // Reject if the raw digit run is < 9 (filters phantom matches
      // where the prefix was absent and only 9 separated digits
      // matched — those are still phone-shaped, but it also filters
      // shorter prefixes that the regex tolerates).
      const digits = m.replace(/\D/g, "");
      return digits.length === 9 || digits.length === 11;
    },
  },
  {
    category: "phone-international",
    // E.164: + followed by 8-15 digits.
    regex: /\+\d{8,15}\b/g,
    failMode: "transform",
  },
  {
    category: "pesel",
    regex: /\b\d{11}\b/g,
    failMode: "transform",
    validate: isValidPesel,
  },
  {
    category: "nip",
    // 10 digits with optional Polish prefix `PL` and optional dashes.
    regex: /\b(?:PL)?\d{3}-?\d{2,3}-?\d{2,3}-?\d{2,3}\b/g,
    failMode: "transform",
    validate: (m) => isValidNip(m.replace(/\D/g, "")),
  },
  {
    category: "regon",
    regex: /\b\d{9}(?:\d{5})?\b/g,
    failMode: "transform",
    validate: (m) => isValidRegon(m.replace(/\D/g, "")),
  },

  // ---------------------------------------------------------------
  // Financial
  // ---------------------------------------------------------------
  {
    category: "iban",
    // Bounded 15-34 alphanumerics after the country+check 4-prefix.
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    failMode: "transform",
    validate: isValidIban,
  },
  {
    category: "credit-card",
    // 13-19 digits with optional spaces or dashes between groups.
    regex: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{1,7}\b/g,
    failMode: "transform",
    validate: (m) => isValidLuhn(m.replace(/\D/g, "")),
  },

  // ---------------------------------------------------------------
  // Secret tokens
  // ---------------------------------------------------------------
  {
    category: "aws-access-key",
    // AWS access key IDs: AKIA + 16 uppercase alphanumerics.
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    failMode: "block",
  },
  {
    category: "aws-secret-key",
    // 40-character base64-ish run NEAR an aws_secret literal. We
    // anchor on the literal so we don't false-positive on every
    // 40-char base64 string.
    regex: /aws[_-]?secret[_-]?(?:access[_-]?)?key["'\s:=]{1,5}[A-Za-z0-9/+]{40}/gi,
    failMode: "block",
  },
  {
    category: "private-key-block",
    // Header marker only — the BEGIN line is the unambiguous signal
    // that a private key was pasted. We match the FULL `-----BEGIN
    // <KIND> PRIVATE KEY-----` line with bounded KIND.
    regex: /-----BEGIN [A-Z]{1,32} PRIVATE KEY-----/g,
    failMode: "block",
  },
  {
    category: "slack-token",
    // xoxb-/xoxp-/xoxa-/xoxs- token shapes; bounded 10-50 hex/alnum
    // tail to dodge ReDoS.
    regex: /\bxox[abps]-\d{10,15}-\d{10,15}-[A-Za-z0-9]{20,50}\b/g,
    failMode: "block",
  },
  {
    category: "github-token",
    // ghp_ (PAT), gho_ (OAuth), ghu_ (user-server token), ghs_
    // (server-server token), ghr_ (refresh) — all 36 alphanumerics
    // after a fixed 4-character prefix.
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,40}\b/g,
    failMode: "block",
  },
  {
    category: "bearer-token",
    // `Bearer <40-200 alnum/punct>`; every quantifier bounded
    // explicitly (copilot #14 Fix 5):
    //   `\s{1,3}`   — at most 3 whitespace chars between `Bearer`
    //                  and the token; the HTTP grammar permits
    //                  exactly one but tab-then-space and similar
    //                  do appear in malformed clients.
    //   `{40,200}`  — token character-class run, already bounded.
    //   `={0,2}`    — base64 padding is at most 2 `=` chars; this
    //                  reflects the canonical RFC 4648 limit.
    regex: /\bBearer\s{1,3}[A-Za-z0-9._~+\/\-]{40,200}={0,2}/g,
    failMode: "block",
  },
] as const satisfies readonly PatternDef[];

export type CategorySlug = (typeof PATTERNS)[number]["category"];

/** Unique categories the adapter declares — used by the engine to
 *  validate per-domain "hide this category" config and surfaced as
 *  `GuardAdapter.categories`. */
export const CATEGORIES = PATTERNS.map((p) => p.category);
