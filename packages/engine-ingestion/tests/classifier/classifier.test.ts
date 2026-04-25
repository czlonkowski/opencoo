/**
 * Classifier orchestrator — wires spotlight + LLM router +
 * Zod-strict parse + binding-guard + path-guard + cross-domain
 * check into one `classify(input, deps)` function.
 *
 * Tests cover the orchestration shape: happy path returns a
 * structured result; any one of the guards throws → orchestrator
 * surfaces a typed error the caller (Scanner pipeline, PR 16+)
 * routes to DLQ.
 *
 * The injection corpus (tests/classifier/injection.test.ts) is
 * the END-TO-END proof against the adversarial-LLM threat model.
 */
import { describe, it, expect } from "vitest";

import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { classify } from "../../src/classifier/classifier.js";
import {
  ClassifierValidationError,
} from "../../src/classifier/errors.js";
import { ClassifierPathError } from "../../src/classifier/path-guard.js";
import { BindingConfigError } from "../../src/classifier/binding-guard.js";

import { freshClassifierDb } from "./_pglite-fixture.js";

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
  const { db, domainId } = await freshClassifierDb();
  const router = new LlmRouter({
    db: db as unknown as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: { paused: () => false, pause: () => undefined, resume: () => undefined },
    provider,
  });
  return { router, domainId };
}

const ALLOWED_PATHS = ["strategy/**", "executive/**"];
const SOURCE_CONTENT = "Q3 priorities: ship the AI-native distribution.";

describe("classify — happy path", () => {
  it("returns a structured ClassifierOutput for a well-behaved LLM response", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "Q3 priorities" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "Q3 priorities — AI-native distribution focus.",
          target_domains: [
            {
              domain_slug: "test-domain",
              page_paths: ["strategy/q3-2026.md"],
            },
          ],
          pipelines: ["compile.single-source"],
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });

    const { router, domainId } = await makeFixture(mock);
    const result = await classify({
      router,
      domainId: domainId as Parameters<typeof classify>[0]["domainId"],
      sourceRef: "drive:doc-1",
      content: SOURCE_CONTENT,
      locale: "en",
      allowedPaths: ALLOWED_PATHS,
      allowedDomains: ["test-domain"],
    });
    expect(result.summary).toContain("Q3 priorities");
    expect(result.targetDomains).toHaveLength(1);
    expect(result.targetDomains[0]?.domainSlug).toBe("test-domain");
    expect(result.targetDomains[0]?.pagePaths).toEqual(["strategy/q3-2026.md"]);
    expect(result.pipelines).toEqual(["compile.single-source"]);
  });
});

describe("classify — adversarial LLM defenses", () => {
  it("DLQs when the LLM emits a path outside allowed_paths (path-guard catch)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "Q3 priorities" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "exfil",
          target_domains: [
            {
              domain_slug: "test-domain",
              // Adversarial: claims to write to hr/ even though
              // allowed_paths only permits strategy/** + executive/**.
              page_paths: ["hr/secret-payroll.md"],
            },
          ],
          pipelines: ["compile.single-source"],
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });

    const { router, domainId } = await makeFixture(mock);
    await expect(
      classify({
        router,
        domainId: domainId as Parameters<typeof classify>[0]["domainId"],
        sourceRef: "drive:doc-1",
        content: SOURCE_CONTENT,
        locale: "en",
        allowedPaths: ALLOWED_PATHS,
        allowedDomains: ["test-domain"],
      }),
    ).rejects.toBeInstanceOf(ClassifierPathError);
  });

  it("DLQs when the LLM emits a domain outside allowed_domains (cross-domain catch)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "Q3 priorities" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "cross-domain attempt",
          target_domains: [
            {
              // Adversarial: fakes a different domain slug.
              domain_slug: "wiki-finance-secrets",
              page_paths: ["strategy/x.md"],
            },
          ],
          pipelines: ["compile.single-source"],
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });

    const { router, domainId } = await makeFixture(mock);
    await expect(
      classify({
        router,
        domainId: domainId as Parameters<typeof classify>[0]["domainId"],
        sourceRef: "drive:doc-1",
        content: SOURCE_CONTENT,
        locale: "en",
        allowedPaths: ALLOWED_PATHS,
        allowedDomains: ["test-domain"],
      }),
    ).rejects.toBeInstanceOf(ClassifierValidationError);
  });

  it("DLQs when the LLM response is not valid JSON (parse fail)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "Q3 priorities" },
      response: {
        text: "this is not JSON, the model went off-script",
        tokensIn: 100,
        tokensOut: 10,
      },
    });

    const { router, domainId } = await makeFixture(mock);
    await expect(
      classify({
        router,
        domainId: domainId as Parameters<typeof classify>[0]["domainId"],
        sourceRef: "drive:doc-1",
        content: SOURCE_CONTENT,
        locale: "en",
        allowedPaths: ALLOWED_PATHS,
        allowedDomains: ["test-domain"],
      }),
    ).rejects.toThrow();
  });

  it("DLQs when the LLM emits an unknown extra field (Zod strict)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "Q3 priorities" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "ok",
          target_domains: [
            {
              domain_slug: "test-domain",
              page_paths: ["strategy/x.md"],
            },
          ],
          pipelines: ["compile.single-source"],
          // Adversarial: extra field the model invented.
          execute_arbitrary_code: "rm -rf /",
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });

    const { router, domainId } = await makeFixture(mock);
    await expect(
      classify({
        router,
        domainId: domainId as Parameters<typeof classify>[0]["domainId"],
        sourceRef: "drive:doc-1",
        content: SOURCE_CONTENT,
        locale: "en",
        allowedPaths: ALLOWED_PATHS,
        allowedDomains: ["test-domain"],
      }),
    ).rejects.toThrow();
  });

  it("rejects at boot when allowed_paths is wildcard-only (binding-guard)", async () => {
    const mock = new MockLlmClient();
    // No registration needed — the binding-guard catches before
    // the LLM is invoked.
    const { router, domainId } = await makeFixture(mock);
    await expect(
      classify({
        router,
        domainId: domainId as Parameters<typeof classify>[0]["domainId"],
        sourceRef: "drive:doc-1",
        content: SOURCE_CONTENT,
        locale: "en",
        allowedPaths: ["**"],
        allowedDomains: ["test-domain"],
      }),
    ).rejects.toBeInstanceOf(BindingConfigError);
  });
});

describe("classify — locale fallback (Q7)", () => {
  it("uses the English prompt when locale='auto'", async () => {
    let promptSeen = "";
    const recorder: LlmProvider = {
      async generate(call) {
        promptSeen = call.prompt;
        return {
          text: JSON.stringify({
            version: "v1",
            language: "en",
            summary: "ok",
            target_domains: [
              { domain_slug: "test-domain", page_paths: ["strategy/x.md"] },
            ],
            pipelines: ["compile.single-source"],
          }),
          tokensIn: 1,
          tokensOut: 1,
        };
      },
    };

    const { router, domainId } = await makeFixture(recorder);
    await classify({
      router,
      domainId: domainId as Parameters<typeof classify>[0]["domainId"],
      sourceRef: "drive:doc-1",
      content: SOURCE_CONTENT,
      locale: "auto",
      allowedPaths: ALLOWED_PATHS,
      allowedDomains: ["test-domain"],
    });
    // English prompt anchor.
    expect(promptSeen).toContain("opencoo Classifier");
  });
});
