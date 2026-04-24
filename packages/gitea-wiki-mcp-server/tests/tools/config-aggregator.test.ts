import { describe, it, expect } from "vitest";

import { validateRepos } from "../../src/config.js";

const BASE = { owner: "opencoo", name: "wiki-x" };

describe("validateRepos — aggregator + reserved slug", () => {
  it("accepts a single repo with aggregator:true", () => {
    expect(() =>
      validateRepos([
        { slug: "roll-up", ...BASE, default: true, aggregator: true },
      ]),
    ).not.toThrow();
  });

  it("accepts multiple repos with exactly one aggregator", () => {
    expect(() =>
      validateRepos([
        { slug: "exec", owner: "opencoo", name: "wiki-exec", default: true },
        {
          slug: "roll-up",
          owner: "opencoo",
          name: "wiki-roll-up",
          aggregator: true,
        },
      ]),
    ).not.toThrow();
  });

  it("accepts a repo set with no aggregator (field absent)", () => {
    expect(() =>
      validateRepos([
        { slug: "exec", owner: "opencoo", name: "wiki-exec", default: true },
      ]),
    ).not.toThrow();
  });

  it("rejects two repos with aggregator:true", () => {
    expect(() =>
      validateRepos([
        {
          slug: "exec",
          owner: "opencoo",
          name: "wiki-exec",
          default: true,
          aggregator: true,
        },
        {
          slug: "hr",
          owner: "opencoo",
          name: "wiki-hr",
          aggregator: true,
        },
      ]),
    ).toThrow(/at most one aggregator/i);
  });

  it("rejects a repo with reserved slug 'company'", () => {
    expect(() =>
      validateRepos([
        {
          slug: "company",
          owner: "opencoo",
          name: "wiki-company",
          default: true,
        },
      ]),
    ).toThrow(/reserved/i);
  });

  it("rejects 'company' slug even with aggregator:true", () => {
    expect(() =>
      validateRepos([
        {
          slug: "company",
          owner: "opencoo",
          name: "wiki-company",
          default: true,
          aggregator: true,
        },
      ]),
    ).toThrow(/reserved/i);
  });
});
