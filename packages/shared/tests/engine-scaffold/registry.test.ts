/**
 * `PipelineRegistry` — engine-agnostic insertion-order Map of
 * pipeline definitions. Tested generically here; consumer
 * packages use the same registry without subclassing.
 */
import { describe, expect, it } from "vitest";

import {
  PipelineRegistry,
  type PipelineDefinition,
} from "../../src/engine-scaffold/index.js";

function stub(name: string): PipelineDefinition {
  return {
    name,
    async run(): Promise<void> {
      /* no-op — context unused in this test stub */
    },
  };
}

describe("PipelineRegistry", () => {
  it("starts empty", () => {
    const r = new PipelineRegistry();
    expect(r.size()).toBe(0);
    expect(r.list()).toEqual([]);
  });

  it("registers + retrieves by name", () => {
    const r = new PipelineRegistry();
    const def = stub("scanner");
    r.register(def);
    expect(r.get("scanner")).toBe(def);
    expect(r.size()).toBe(1);
  });

  it("preserves insertion order in list()", () => {
    const r = new PipelineRegistry();
    r.register(stub("scanner"));
    r.register(stub("compiler"));
    r.register(stub("lint"));
    expect(r.list().map((d) => d.name)).toEqual([
      "scanner",
      "compiler",
      "lint",
    ]);
  });

  it("throws on duplicate name (no silent overwrite)", () => {
    const r = new PipelineRegistry();
    r.register(stub("scanner"));
    expect(() => r.register(stub("scanner"))).toThrow(/duplicate pipeline name/i);
  });

  it("returns undefined for missing name", () => {
    expect(new PipelineRegistry().get("nope")).toBeUndefined();
  });
});
