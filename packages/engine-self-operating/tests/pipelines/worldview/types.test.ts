/**
 * Worldview output schema + token cap tests (PR 22 / plan #106).
 *
 * The 24,000-byte UTF-8 cap on `body` is LOAD-BEARING: worldview.md
 * is injected verbatim into every downstream agent's system
 * prompt. Going over the cap pushes the prompt out of the
 * model's context window. Zod's refinement enforces structurally;
 * the prompt asks the model to compress; if a retry still
 * overflows, WorldviewOverflowError fires (other test).
 */
import { describe, expect, it } from "vitest";

import {
  WORLDVIEW_BODY_MAX_BYTES,
  WORLDVIEW_OUTPUT_SCHEMA,
  utf8ByteLength,
} from "../../../src/pipelines/worldview/index.js";

describe("WORLDVIEW_OUTPUT_SCHEMA — strict Zod + 24KB cap", () => {
  it("accepts a small valid payload", () => {
    const ok = { version: "v1" as const, body: "# domain\nlead sentence." };
    expect(() => WORLDVIEW_OUTPUT_SCHEMA.parse(ok)).not.toThrow();
  });

  it("accepts a body at exactly 24,000 bytes (boundary inclusive)", () => {
    const body = "x".repeat(WORLDVIEW_BODY_MAX_BYTES); // ASCII = 1 byte each
    expect(() =>
      WORLDVIEW_OUTPUT_SCHEMA.parse({ version: "v1", body }),
    ).not.toThrow();
  });

  it("rejects a body at 24,001 bytes (over the cap)", () => {
    const body = "x".repeat(WORLDVIEW_BODY_MAX_BYTES + 1);
    expect(() =>
      WORLDVIEW_OUTPUT_SCHEMA.parse({ version: "v1", body }),
    ).toThrow(/byte UTF-8 cap/);
  });

  it("counts UTF-8 bytes, not code units (kanji = 3 bytes each)", () => {
    // 8001 kanji = 24003 bytes — over the 24000 cap, even
    // though the JS string length is only 8001.
    const body = "字".repeat(8001);
    expect(utf8ByteLength(body)).toBeGreaterThan(WORLDVIEW_BODY_MAX_BYTES);
    expect(() =>
      WORLDVIEW_OUTPUT_SCHEMA.parse({ version: "v1", body }),
    ).toThrow(/byte UTF-8 cap/);
  });

  it("rejects empty body (.min(1))", () => {
    expect(() =>
      WORLDVIEW_OUTPUT_SCHEMA.parse({ version: "v1", body: "" }),
    ).toThrow();
  });

  it("rejects unknown top-level fields (.strict)", () => {
    const bad = {
      version: "v1",
      body: "ok",
      malicious: "ignored?",
    };
    expect(() => WORLDVIEW_OUTPUT_SCHEMA.parse(bad)).toThrow();
  });

  it("rejects wrong version literal", () => {
    expect(() =>
      WORLDVIEW_OUTPUT_SCHEMA.parse({ version: "v2", body: "ok" }),
    ).toThrow();
  });
});
