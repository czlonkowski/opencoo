/**
 * Reusable contract suite for the `DocumentConverterAdapter` boundary.
 *
 * Every adapter that converts source bytes → Markdown (Docling, Pandoc,
 * a future native parser) implements this interface and passes the same
 * assertion matrix. The suite lives in `@opencoo/shared` so that a
 * regression in ONE adapter can't silently drift from the contract
 * another adapter holds itself to — there's literally one test shape.
 *
 * Callers — from `packages/adapters/converter-*` test files:
 *
 * ```ts
 * import { documentConverterContract } from "@opencoo/shared/adapter-contract-tests/document-converter";
 *
 * documentConverterContract(
 *   (clientResponses) => converterDocling(new MockDoclingClient(clientResponses)),
 *   fixtures,
 * );
 * ```
 *
 * THREAT-MODEL §3.2 governs what the suite verifies:
 *   - fail-closed on malformed input (no silent zero-length Markdown),
 *   - six script-adjacent tag families stripped,
 *   - `javascript:` URIs + `on*=` handlers neutralised,
 *   - `@opencoo/shared/text-normalize` applied exactly once (idempotent
 *     second pass),
 *   - two named degradation heuristics (`xlsx-no-pipes`,
 *     `pptx-no-headings`) flagged in `degraded`/`degradationReason`.
 */
import { describe, it, expect } from "vitest";

import { OpencooError, type OpencooErrorOptions } from "../errors.js";

// ---------------------------------------------------------------------------
// Adapter surface
// ---------------------------------------------------------------------------

/**
 * Signals a converter extracts from the rendered Markdown. Engines use
 * these to decide follow-up actions (lint flags, degradation UI, etc.)
 * without re-parsing the Markdown themselves.
 */
export interface StructureSignals {
  /** Number of distinct GFM-pipe tables detected in the output. */
  readonly detectedTables: number;
  /** Raw count of `|` characters outside fenced code blocks. Used as
   *  a cheap "does this look tabular?" signal for XLSX degradation. */
  readonly gfmPipes: number;
  /** Number of ATX headings (`# `, `## `, …). Used for PPTX
   *  degradation ("a deck with zero headings is suspicious"). */
  readonly detectedHeadings: number;
}

export type DegradationReason =
  | "xlsx-no-pipes"
  | "pptx-no-headings"
  | "unknown-structure";

export interface ConversionResult {
  readonly markdown: string;
  readonly structureSignals: StructureSignals;
  /** True when one or more degradation heuristics fired. */
  readonly degraded: boolean;
  /** Populated iff `degraded === true`. */
  readonly degradationReason?: DegradationReason;
}

export interface ConvertArgs {
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly filename: string;
}

export interface DocumentConverterAdapter {
  /** Stable identifier written into `llm_usage.pipeline_or_agent` /
   *  logs. Never a display string — slug-cased. */
  readonly slug: string;
  /** MIME types the adapter accepts. Callers route on this list. */
  readonly mimeTypes: readonly string[];
  convert(args: ConvertArgs): Promise<ConversionResult>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ConversionErrorReason =
  | "malformed-input"
  | "sidecar-unreachable"
  | "timeout";

/**
 * Every converter failure surfaces as a `ConversionError`. Pinned to
 * `errorClass: 'validation'` so retry logic treats it as a bad-input DLQ
 * case — retrying a PDF with the same bytes won't change the answer.
 * The `reason` discriminant lets the Review Dashboard render a
 * targeted operator hint.
 */
export class ConversionError extends OpencooError {
  readonly reason: ConversionErrorReason;

  constructor(
    message: string,
    reason: ConversionErrorReason,
    options?: OpencooErrorOptions,
  ) {
    super(message, "validation", options);
    this.name = "ConversionError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Canned client response — what the adapter's underlying sidecar (e.g.
 * Docling, Pandoc) is expected to return. The adapter layers its own
 * HTML-scrub + signal extraction + normalize on top. `undefined` means
 * the client is expected to throw (malformed-input path).
 */
export interface CannedClientResponse {
  readonly markdown: string;
  readonly structureSignals?: Partial<StructureSignals>;
}

interface FixtureBase {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
}

export interface HappyPathFixture extends FixtureBase {
  readonly clientResponse: CannedClientResponse;
  /** Substring the suite asserts is present in the final Markdown. */
  readonly expectedMarkdownIncludes: string;
}

export interface DegradationFixture extends FixtureBase {
  readonly clientResponse: CannedClientResponse;
}

export interface HtmlHostileFixture extends FixtureBase {
  /**
   * The raw Markdown the client is expected to return BEFORE the
   * adapter's HTML scrub runs. Must include at least one tag from each
   * of the six families, one `javascript:` URI and one `on*=` handler.
   */
  readonly clientResponse: CannedClientResponse;
}

/**
 * No canned response — the MockClient is expected to throw when the
 * adapter forwards these bytes. Pure alias of FixtureBase; declared
 * separately for readability in the `DocumentConverterFixtures` record.
 */
export type MalformedFixture = FixtureBase;

export interface DocumentConverterFixtures {
  readonly happyPath: HappyPathFixture;
  readonly xlsxNoPipes: DegradationFixture;
  readonly pptxNoHeadings: DegradationFixture;
  readonly htmlHostile: HtmlHostileFixture;
  readonly malformed: MalformedFixture;
}

/**
 * Per-call argument the adapter factory needs when the suite swaps in a
 * canned client response. Adapters under test accept a pre-seeded mock
 * client from the test file and THIS function lets the suite push a new
 * mapping for each fixture case.
 */
export type MakeAdapter = (
  cannedResponses: ReadonlyArray<{
    readonly filename: string;
    readonly mimeType: string;
    readonly response: CannedClientResponse | "throw";
  }>,
) => DocumentConverterAdapter;

export interface ContractOptions {
  /** Optional slug the suite asserts against `adapter.slug` when set. */
  readonly expectedSlug?: string;
  /** MIME types the adapter MUST declare. If omitted, the suite just
   *  asserts that `mimeTypes` is non-empty. */
  readonly expectedMimeTypes?: readonly string[];
}

// ---------------------------------------------------------------------------
// Regexes the suite uses to verify scrubbing — single source of truth so
// adapter impls and the suite never drift.
// ---------------------------------------------------------------------------

const TAG_FAMILIES = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
] as const;

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/**
 * Call from inside an adapter package's test file. Wraps one top-level
 * `describe` block with every assertion; the caller can still add
 * package-specific tests above or below.
 */
export function documentConverterContract(
  makeAdapter: MakeAdapter,
  fixtures: DocumentConverterFixtures,
  options: ContractOptions = {},
): void {
  // Build an adapter with a single canned response for `fixture`, then
  // drive it with the same fixture's bytes/mimeType/filename. The
  // pre-seed shape is `{filename, mimeType, response}` — the mock
  // matches on (filename, mimeType) — and the convert call mirrors it.
  // Factored so every assertion body below stays focused on the expect.
  async function convertFixture(
    fixture: FixtureBase & { readonly clientResponse?: CannedClientResponse },
    responseOverride?: CannedClientResponse | "throw",
  ): Promise<ConversionResult> {
    const response =
      responseOverride ??
      fixture.clientResponse ??
      // FixtureBase without clientResponse is the malformed case, which
      // must always pass responseOverride: "throw". If we get here, the
      // caller set up the fixture wrong — fail loud.
      (() => {
        throw new Error(
          "convertFixture: fixture has no clientResponse and no responseOverride",
        );
      })();
    const adapter = makeAdapter([
      {
        filename: fixture.filename,
        mimeType: fixture.mimeType,
        response,
      },
    ]);
    return adapter.convert({
      bytes: fixture.bytes,
      mimeType: fixture.mimeType,
      filename: fixture.filename,
    });
  }

  describe("DocumentConverterAdapter contract", () => {
    it("declares a stable slug", () => {
      const adapter = makeAdapter([]);
      expect(typeof adapter.slug).toBe("string");
      expect(adapter.slug.length).toBeGreaterThan(0);
      if (options.expectedSlug !== undefined) {
        expect(adapter.slug).toBe(options.expectedSlug);
      }
    });

    it("declares at least one MIME type", () => {
      const adapter = makeAdapter([]);
      expect(Array.isArray(adapter.mimeTypes)).toBe(true);
      expect(adapter.mimeTypes.length).toBeGreaterThan(0);
      if (options.expectedMimeTypes !== undefined) {
        for (const m of options.expectedMimeTypes) {
          expect(adapter.mimeTypes).toContain(m);
        }
      }
    });

    it("converts a happy-path document to Markdown + structureSignals", async () => {
      const result = await convertFixture(fixtures.happyPath);
      expect(result.markdown).toContain(
        fixtures.happyPath.expectedMarkdownIncludes,
      );
      expect(result.structureSignals).toBeDefined();
      expect(result.degraded).toBe(false);
      expect(result.degradationReason).toBeUndefined();
    });

    it("flags xlsx-no-pipes degradation when an XLSX converts with zero pipes", async () => {
      const result = await convertFixture(fixtures.xlsxNoPipes);
      expect(result.degraded).toBe(true);
      expect(result.degradationReason).toBe("xlsx-no-pipes");
    });

    it("flags pptx-no-headings degradation when a PPTX converts with zero headings", async () => {
      const result = await convertFixture(fixtures.pptxNoHeadings);
      expect(result.degraded).toBe(true);
      expect(result.degradationReason).toBe("pptx-no-headings");
    });

    it("strips script/style/iframe/object/embed/form tag families from HTML output", async () => {
      const result = await convertFixture(fixtures.htmlHostile);
      for (const tag of TAG_FAMILIES) {
        const re = new RegExp(`<${tag}\\b`, "i");
        expect(result.markdown).not.toMatch(re);
      }
    });

    it("neutralises javascript: URIs in Markdown links", async () => {
      const result = await convertFixture(fixtures.htmlHostile);
      expect(result.markdown).not.toMatch(/]\(\s*javascript:/i);
    });

    it("strips on*= inline event handlers", async () => {
      const result = await convertFixture(fixtures.htmlHostile);
      expect(result.markdown).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    });

    it("fails closed with ConversionError when the sidecar client throws on malformed bytes", async () => {
      await expect(convertFixture(fixtures.malformed, "throw")).rejects.toBeInstanceOf(
        ConversionError,
      );
    });

    it("applies text-normalize exactly once — running the output through normalize again is a no-op", async () => {
      const { normalize } = await import("../text-normalize.js");
      const result = await convertFixture(fixtures.happyPath);
      // normalize is idempotent by construction; if the adapter applied
      // it, a second pass is equal-bytes. If it did NOT, a second pass
      // will differ (line endings, NFC, etc.).
      expect(normalize(result.markdown)).toBe(result.markdown);
    });
  });
}
