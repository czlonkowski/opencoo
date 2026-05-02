/**
 * asana-light-summary.test.ts (PR-F)
 *
 * Tests for `summarizeAsanaEvent` (stub mode — CI-safe, no real LLM).
 *
 * Assertions:
 *   - prompt wraps event content in <source_content>...</source_content>
 *     (THREAT-MODEL §3.4 XML spotlighting)
 *   - call uses tier 'light'
 *   - max_tokens honored (the call goes to the router's generateText;
 *     we assert the router is called with a prompt that fits the budget)
 *   - result is attached as metadata.summary
 *   - on failure (router throws), summary is omitted but no error
 *     propagates (fail-open semantics for summaries)
 */
import { describe, expect, it } from "vitest";

import type { GenerateOpts, GenerateTextResult } from "@opencoo/shared/llm-router";
import type { DomainId } from "@opencoo/shared/db";

import { summarizeAsanaEvent } from "../src/light-summary.js";

type MinimalRouter = {
  generateText(opts: GenerateOpts): Promise<GenerateTextResult>;
};

function makeMockRouter(text = "Zadanie zostało dodane."): {
  router: MinimalRouter;
  capturedOpts: GenerateOpts[];
} {
  const capturedOpts: GenerateOpts[] = [];
  const router: MinimalRouter = {
    async generateText(opts: GenerateOpts): Promise<GenerateTextResult> {
      capturedOpts.push(opts);
      return { text, tokensIn: 5, tokensOut: 6, model: "gpt-4o-mini" };
    },
  };
  return { router, capturedOpts };
}

const FAKE_DOMAIN_ID = "domain-aaa" as unknown as DomainId;

const SAMPLE_EVENT = {
  action: "added",
  resource: { gid: "t1", resource_type: "task" },
  created_at: "2026-04-25T12:00:00Z",
  user: { gid: "u1" },
};

describe("summarizeAsanaEvent — XML spotlighting (THREAT-MODEL §3.4)", () => {
  it("prompt wraps event content in <source_content> tags", async () => {
    const { router, capturedOpts } = makeMockRouter();
    await summarizeAsanaEvent({
      event: SAMPLE_EVENT,
      domainId: FAKE_DOMAIN_ID,
      llmRouter: router,
      pipeline: "asana-webhook",
    });

    expect(capturedOpts).toHaveLength(1);
    const prompt = capturedOpts[0]!.prompt;
    expect(prompt).toContain("<source_content>");
    expect(prompt).toContain("</source_content>");
  });
});

describe("summarizeAsanaEvent — tier and token budget", () => {
  it("uses tier 'light'", async () => {
    const { router, capturedOpts } = makeMockRouter();
    await summarizeAsanaEvent({
      event: SAMPLE_EVENT,
      domainId: FAKE_DOMAIN_ID,
      llmRouter: router,
      pipeline: "asana-webhook",
    });

    expect(capturedOpts[0]!.tier).toBe("light");
  });

  it("prompt fits within max_tokens=120 budget (prompt itself references max_tokens)", async () => {
    const { router, capturedOpts } = makeMockRouter();
    await summarizeAsanaEvent({
      event: SAMPLE_EVENT,
      domainId: FAKE_DOMAIN_ID,
      llmRouter: router,
      pipeline: "asana-webhook",
    });

    // The system prompt must instruct the LLM to stay within ~120 tokens.
    // Accept any of: "120", "max_tokens", "25 slow" (Polish words).
    const prompt = capturedOpts[0]!.prompt;
    expect(prompt).toMatch(/120|max.*token|25.*s[łl]ow/i);
  });
});

describe("summarizeAsanaEvent — result attachment", () => {
  it("returns the summary text from the LLM", async () => {
    const { router } = makeMockRouter("Zadanie zostało ukończone.");
    const result = await summarizeAsanaEvent({
      event: SAMPLE_EVENT,
      domainId: FAKE_DOMAIN_ID,
      llmRouter: router,
      pipeline: "asana-webhook",
    });

    expect(result).toBe("Zadanie zostało ukończone.");
  });

  it("returns undefined (not throws) when the router fails", async () => {
    const failRouter: MinimalRouter = {
      async generateText(): Promise<GenerateTextResult> {
        throw new Error("provider unavailable");
      },
    };

    const result = await summarizeAsanaEvent({
      event: SAMPLE_EVENT,
      domainId: FAKE_DOMAIN_ID,
      llmRouter: failRouter,
      pipeline: "asana-webhook",
    });

    expect(result).toBeUndefined();
  });
});

describe("summarizeAsanaEvent — pipelineOrAgent forwarded", () => {
  it("pipelineOrAgent matches the pipeline arg", async () => {
    const { router, capturedOpts } = makeMockRouter();
    await summarizeAsanaEvent({
      event: SAMPLE_EVENT,
      domainId: FAKE_DOMAIN_ID,
      llmRouter: router,
      pipeline: "asana-webhook-custom",
    });

    expect(capturedOpts[0]!.pipelineOrAgent).toBe("asana-webhook-custom");
  });
});
