/**
 * `mergePage` — wraps one LlmRouter.generateObject<MergedPageBody>
 * call. Builds the prompt (compiler body + spotlighted source +
 * existing-page envelope), invokes the router with tier:'thinker',
 * and returns the strict-Zod-parsed { merged_body, worldview_impact }.
 *
 * This is the unit boundary the compiler orchestrator composes —
 * separates "talk to the model" from "decide what to do with the
 * result".
 */
import { describe, expect, it } from "vitest";

import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { mergePage } from "../../src/compiler/merge-page.js";
import { CompilerValidationError } from "../../src/compiler/errors.js";

import { freshCompilerDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

interface FixtureBundle {
  router: LlmRouter;
  domainId: string;
}

async function makeFixture(provider: LlmProvider): Promise<FixtureBundle> {
  const { db, domainId } = await freshCompilerDb();
  const router = new LlmRouter({
    db: db as unknown as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: { paused: () => false, pause: () => undefined, resume: () => undefined },
    provider,
  });
  return { router, domainId };
}

describe("mergePage — happy path", () => {
  it("returns { mergedBody, worldviewImpact } parsed from a strict-Zod LLM response", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "# Q3\n\nDistribution motion.\n",
          worldview_impact: ["Distribution prioritised over feature work"],
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });
    const { router, domainId } = await makeFixture(mock);
    const result = await mergePage({
      router,
      domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
      sourceRef: "drive:doc-1",
      sourceContent: "Q3 priorities: distribution.",
      existingPageContent: "",
      pagePath: "strategy/q3-2026.md",
      locale: "en",
    });
    expect(result.mergedBody).toContain("Distribution motion");
    expect(result.worldviewImpact).toEqual([
      "Distribution prioritised over feature work",
    ]);
    expect(result.promptVersion).toBe("1.0.0");
  });

  it("accepts an empty worldview_impact array (commit only adds detail)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "# Existing\n\nUnchanged.\n",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const { router, domainId } = await makeFixture(mock);
    const result = await mergePage({
      router,
      domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
      sourceRef: "drive:doc-1",
      sourceContent: "x",
      existingPageContent: "old",
      pagePath: "strategy/x.md",
      locale: "en",
    });
    expect(result.worldviewImpact).toEqual([]);
  });
});

describe("mergePage — Zod-strict rejects bad LLM output", () => {
  it("DLQs when merged_body is missing", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({ worldview_impact: [] }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const { router, domainId } = await makeFixture(mock);
    await expect(
      mergePage({
        router,
        domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
        sourceRef: "drive:doc-1",
        sourceContent: "x",
        existingPageContent: "",
        pagePath: "strategy/x.md",
        locale: "en",
      }),
    ).rejects.toThrow();
  });

  it("DLQs when LLM emits an extra field (Zod strict)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "ok",
          worldview_impact: [],
          execute_arbitrary_code: "rm -rf /",
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const { router, domainId } = await makeFixture(mock);
    await expect(
      mergePage({
        router,
        domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
        sourceRef: "drive:doc-1",
        sourceContent: "x",
        existingPageContent: "",
        pagePath: "strategy/x.md",
        locale: "en",
      }),
    ).rejects.toThrow();
  });
});

describe("mergePage — backstop sentinel scrub", () => {
  it("DLQs when merged_body still contains literal <source_content (CompilerValidationError)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "ok content <source_content>leak</source_content>",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const { router, domainId } = await makeFixture(mock);
    await expect(
      mergePage({
        router,
        domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
        sourceRef: "drive:doc-1",
        sourceContent: "x",
        existingPageContent: "",
        pagePath: "strategy/x.md",
        locale: "en",
      }),
    ).rejects.toBeInstanceOf(CompilerValidationError);
  });

  it("DLQs when merged_body starts with --- (model tried to write its own frontmatter)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "---\ntitle: hijacked\n---\nbody",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const { router, domainId } = await makeFixture(mock);
    await expect(
      mergePage({
        router,
        domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
        sourceRef: "drive:doc-1",
        sourceContent: "x",
        existingPageContent: "",
        pagePath: "strategy/x.md",
        locale: "en",
      }),
    ).rejects.toBeInstanceOf(CompilerValidationError);
  });
});
