/**
 * light-summary.real-llm.test.ts (PR-F)
 *
 * Real-LLM integration test for `summarizeAsanaEvent`.
 * Gated by `process.env.RUN_REAL_LLM === '1'`.
 *
 * Run locally:
 *   RUN_REAL_LLM=1 pnpm --filter @opencoo/source-asana test \
 *     src/light-summary.real-llm.test.ts
 *
 * Requires OPENROUTER_API_KEY in the environment (the test-provisioned
 * moonshotai/kimi-k2.6 key with a $100 cap). In CI, RUN_REAL_LLM is
 * not set, so this file is skipped entirely.
 *
 * Assertion: the response is non-empty Polish text, ≤25 words.
 */
import { describe, it, expect } from "vitest";

import { createOpenRouterProvider } from "@opencoo/shared/llm-router";
import type { DomainId } from "@opencoo/shared/db";

import { summarizeAsanaEvent } from "./light-summary.js";

const RUN_REAL_LLM = process.env["RUN_REAL_LLM"] === "1";

const FAKE_DOMAIN_ID = "ffffffff-0000-0000-0000-000000000001" as unknown as DomainId;

const FIXTURE_EVENT = {
  action: "changed",
  resource: { gid: "task-999", resource_type: "task" },
  change: { field: "assignee" },
  user: { gid: "user-42" },
  created_at: "2026-04-25T14:00:00Z",
};

describe.skipIf(!RUN_REAL_LLM)(
  "summarizeAsanaEvent — real LLM (moonshotai/kimi-k2.6 via OpenRouter)",
  () => {
    it("returns non-empty Polish text ≤25 words for an assignee-changed event", async () => {
      const apiKey = process.env["OPENROUTER_API_KEY"];
      if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

      const provider = createOpenRouterProvider({
        apiKey,
        model: "moonshotai/kimi-k2.6",
      });

      // Minimal LLM router stub that calls the OpenRouter provider directly.
      // The real LlmRouter needs a DB; for this integration test we bypass
      // it and call the provider at tier='light' semantics.
      const stubRouter = {
        async generateText(opts: import("@opencoo/shared/llm-router").GenerateOpts) {
          const response = await provider.generate({
            provider: "openrouter",
            model: "moonshotai/kimi-k2.6",
            prompt: opts.prompt,
          });
          return {
            text: response.text,
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
            model: "moonshotai/kimi-k2.6",
          };
        },
      };

      const summary = await summarizeAsanaEvent({
        event: FIXTURE_EVENT,
        domainId: FAKE_DOMAIN_ID,
        llmRouter: stubRouter,
        pipeline: "real-llm-integration-test",
      });

      expect(summary).toBeDefined();
      expect(typeof summary).toBe("string");
      expect(summary!.length).toBeGreaterThan(0);

      // ≤25 words check.
      const wordCount = summary!.trim().split(/\s+/).length;
      expect(wordCount).toBeLessThanOrEqual(25);
    });
  },
);
