/**
 * Shape-lock for `@opencoo/shared/adapter-contract-tests/wiki-adapter`.
 *
 * The contract is the WikiAdapter port (interface.ts §132). Every backend
 * — `InMemoryWikiAdapter`, `wiki-gitea`, a future `wiki-github` — passes
 * the SAME 13-assertion suite. This file does not invoke the suite; it
 * only locks the module's exported shape so adapter packages can rely on
 * what they import.
 *
 * The 13 assertions the generator runs are documented in the module
 * itself (`documentConverterContract` shape-test mirrors this).
 */
import { describe, it, expect } from "vitest";

import {
  wikiAdapterContract,
  type WikiAdapterFixtureOptions,
} from "../src/adapter-contract-tests/wiki-adapter.js";

describe("adapter-contract-tests/wiki-adapter — module shape", () => {
  it("exports wikiAdapterContract as a function", () => {
    expect(typeof wikiAdapterContract).toBe("function");
  });

  it("WikiAdapterFixtureOptions type exposes makeAdapter + a fresh-state hook", () => {
    // Compile-time-only stub — drift in either field name fails this
    // file alongside any consumer that imports the same type.
    const _stub: WikiAdapterFixtureOptions = {
      backendName: "in-memory",
      makeAdapter: async () => ({
        adapter: {
          async getHeadSha() {
            return "deadbeef";
          },
          async readPage() {
            return null;
          },
          async writeAtomic() {
            return { status: "ok", sha: "deadbeef" };
          },
        },
        cleanup: async () => undefined,
      }),
    };
    expect(_stub.backendName).toBe("in-memory");
  });
});
