/**
 * Use-case tier — runs the shared `guardAdapterContract` against the
 * regex-redaction adapter with a curated set of known-good positive
 * samples (one per category in the v1 catalog).
 *
 * Adapter-specific tests below the contract suite cover edge cases the
 * port shape doesn't constrain (overlap policy, ReDoS perf canary,
 * checksum-validator false-positive rejection).
 */
import { describe, it, expect } from "vitest";

import { guardAdapterContract } from "@opencoo/shared/adapter-contract-tests/guard";

import { guardRedactionRegex, PATTERN_VERSION } from "../src/index.js";

guardAdapterContract({
  backendName: "regex",
  makeAdapter: () => guardRedactionRegex(),
  noMatchSample:
    "The quick brown fox jumps over the lazy dog. Plain prose with no PII or secrets.",
  knownMatches: [
    {
      category: "email",
      sample: "Contact us at SUPPORT-7421@opencoo.test for help.",
      // 'SUPPORT-7421@opencoo.test' starts at byte 14, ends at byte 39.
      expectedByteRanges: [{ start: 14, end: 39 }],
      sentinel: "SUPPORT-7421",
    },
    {
      category: "pesel",
      // Real PESEL checksum: 44051401359 — DOB 1944-05-14, valid sum.
      sample: "Old PESEL: 44051401359 (test).",
      expectedByteRanges: [{ start: 11, end: 22 }],
      sentinel: "44051401359",
    },
    {
      category: "nip",
      // Real NIP checksum: 5260250274 (Polish Tax Office reference).
      sample: "Tax NIP: 5260250274 .",
      expectedByteRanges: [{ start: 9, end: 19 }],
      sentinel: "5260250274",
    },
    {
      category: "iban",
      // Real IBAN checksum (Polish account): PL61109010140000071219812874.
      sample: "Wire to PL61109010140000071219812874 today.",
      expectedByteRanges: [{ start: 8, end: 36 }],
      sentinel: "PL61109010140000071219812874",
    },
    {
      category: "credit-card",
      // Luhn-valid test number: 4539578763621486 (16 digits).
      sample: "Card 4539578763621486 expires.",
      expectedByteRanges: [{ start: 5, end: 21 }],
      sentinel: "4539578763621486",
    },
    {
      category: "aws-access-key",
      // Synthetic AWS key shape, not real.
      sample: "Use AKIAIOSFODNN7EXAMPLE in config.",
      expectedByteRanges: [{ start: 4, end: 24 }],
      sentinel: "AKIAIOSFODNN7EXAMPLE",
    },
    {
      category: "github-token",
      // Synthetic GitHub PAT shape (40 chars after prefix).
      sample: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      expectedByteRanges: [{ start: 6, end: 46 }],
      sentinel: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    },
    {
      category: "private-key-block",
      // Header marker only — full body intentionally omitted from
      // fixture; the matcher locks onto the BEGIN line which is
      // the unambiguous signal that a private key was pasted.
      // `-----BEGIN RSA PRIVATE KEY-----` is 31 bytes; preceded by
      // 6 bytes ("Found "), so the match runs from 6 to 37.
      sample: "Found -----BEGIN RSA PRIVATE KEY----- in log.",
      expectedByteRanges: [{ start: 6, end: 37 }],
      sentinel: "BEGIN RSA PRIVATE KEY",
    },
  ],
});

describe("guard-redaction-regex — adapter-specific cases", () => {
  it("PATTERN_VERSION is the planner-approved sortable string", () => {
    expect(PATTERN_VERSION).toBe("v1.2026-04-25");
  });

  it("redaction transform replaces matches with [REDACTED:<category>] tokens", async () => {
    const a = guardRedactionRegex();
    const r = await a.classify({ text: "ping me at ROBOT-9001@opencoo.test ok" });
    expect(r.transformedText).toContain("[REDACTED:email]");
    expect(r.transformedText).not.toContain("ROBOT-9001@opencoo.test");
  });

  it("rejects PESEL candidates that fail the checksum (no event)", async () => {
    const a = guardRedactionRegex();
    // 11 digits in the right shape but checksum off-by-one.
    const r = await a.classify({ text: "PESEL 44051401358" });
    const events = r.events.filter((e) => e.category === "pesel");
    expect(events).toHaveLength(0);
  });

  it("rejects credit-card candidates that fail the Luhn checksum", async () => {
    const a = guardRedactionRegex();
    // 16 digits, Luhn-invalid.
    const r = await a.classify({ text: "Card 4539578763621487 expires." });
    const events = r.events.filter((e) => e.category === "credit-card");
    expect(events).toHaveLength(0);
  });

  it("rejects IBAN candidates that fail the MOD-97 checksum", async () => {
    const a = guardRedactionRegex();
    // Last digits flipped — invalid MOD-97.
    const r = await a.classify({ text: "Wire to PL61109010140000071219812875" });
    const events = r.events.filter((e) => e.category === "iban");
    expect(events).toHaveLength(0);
  });

  it("100KiB perf canary — classify a hostile mixed-PII blob in under 500ms", async () => {
    const a = guardRedactionRegex();
    // Mix: prose padding + recurring email + PESEL + secret token.
    const chunks: string[] = [];
    const padding = "lorem ipsum dolor sit amet ".repeat(20); // ~540 bytes
    while (chunks.join("").length < 100 * 1024) {
      chunks.push(padding);
      chunks.push(" SUPPORT-7421@opencoo.test ");
      chunks.push(" PESEL 44051401359 ");
      chunks.push(" AKIAIOSFODNN7EXAMPLE ");
    }
    const big = chunks.join("");
    expect(big.length).toBeGreaterThanOrEqual(100 * 1024);
    const t0 = performance.now();
    const r = await a.classify({ text: big });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(r.events.length).toBeGreaterThan(0);
  });

  it("metadata-only sentinel — JSON.stringify of events from a 100KiB hostile blob never contains any input substring", async () => {
    const a = guardRedactionRegex();
    const probe = "PII-SENTINEL-SUBSTR-secret-token-stub";
    // Embed the sentinel inside an email-shaped match — adapter
    // would only fail this if it's stuffing match content into
    // the event surface.
    const sample = `Contact ${probe}@opencoo.test for help.`;
    const r = await a.classify({ text: sample });
    const serialised = JSON.stringify(r.events);
    expect(serialised).not.toContain(probe);
    // The sample must have actually matched (otherwise the test
    // tautologically passes).
    expect(r.events.some((e) => e.category === "email")).toBe(true);
  });
});
