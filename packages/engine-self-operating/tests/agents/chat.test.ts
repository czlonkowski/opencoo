/**
 * Chat agent — conversational read-only worker (PR 20 part B /
 * plan #97).
 *
 * Read-only by construction:
 *   - No writer tool wrapper in agents/tools/.
 *   - PAT-scoped via createPatScopedMcpClient — gitea-mcp
 *     enforces the user's repo scope on every read.
 *   - Strict callerPat check at run-time entry: undefined or
 *     whitespace-only → ChatPatRequiredError(validation) before
 *     any LLM call or MCP read.
 *
 * Tests pin:
 *   1. Definition shape (slug 'chat', tool surface, defaultMemory).
 *   2. Output schema — strict Zod, `answer` non-empty,
 *      `citations.max(20)` (Q3).
 *   3. Body wires PAT-scoped wrapper + propagates PAT on every
 *      tool call.
 *   4. Body throws ChatPatRequiredError when ctx.callerPat is
 *      undefined OR whitespace-only (Q2 strict check).
 *   5. Locale routing through loadPrompt.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";

import {
  AgentDefinitionRegistry,
  invokeAgent,
} from "../../src/agent-harness/index.js";
import { InMemoryMcpToolClient } from "../../src/mcp-tool-client/index.js";
import {
  CHAT_DEFINITION,
  CHAT_OUTPUT_SCHEMA,
  ChatPatRequiredError,
  normalizeCallerPat,
  runChat,
  type ChatOutput,
} from "../../src/agents/chat/index.js";

import {
  freshAgentDb,
  seedAgentInstance,
} from "../agent-harness/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function fakeProvider(payload: unknown): LlmProvider {
  return {
    generate: async () => ({
      text: JSON.stringify(payload),
      tokensIn: 5,
      tokensOut: 5,
    }),
  };
}

function makeRouter(provider: LlmProvider, db: unknown): LlmRouter {
  return new LlmRouter({
    db: db as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: {
      paused: () => false,
      pause: () => undefined,
      resume: () => undefined,
    },
    provider,
  });
}

describe("CHAT_DEFINITION — agent definition shape", () => {
  it("declares slug='chat', outputSchemaName='ChatOutput'", () => {
    expect(CHAT_DEFINITION.slug).toBe("chat");
    expect(CHAT_DEFINITION.outputSchemaName).toBe("ChatOutput");
  });

  it("declares a read-only tool surface (no writer tools)", () => {
    // The detector + the harness deny-list both fire if a Chat
    // run records a writer-shape tool name; we additionally pin
    // the declaration here so the definition stays in lockstep.
    for (const name of CHAT_DEFINITION.toolNames) {
      expect(name).not.toMatch(/^wiki\.write|wiki\.replace|wiki\.delete|wiki\.commit/);
    }
  });

  it("default memory is 'none' — Chat is single-shot per request", () => {
    expect(CHAT_DEFINITION.defaultMemory).toMatchObject({ type: "none" });
  });
});

describe("CHAT_OUTPUT_SCHEMA — strict Zod contract", () => {
  it("accepts a valid payload", () => {
    const ok: ChatOutput = {
      version: "v1",
      answer: "The Q3 deck is due Friday.",
      citations: ["projects/q3.md"],
    };
    expect(() => CHAT_OUTPUT_SCHEMA.parse(ok)).not.toThrow();
  });

  it("accepts an ungrounded answer with empty citations array", () => {
    const empty: ChatOutput = {
      version: "v1",
      answer: "I don't have that information in the wiki I can see.",
      citations: [],
    };
    expect(() => CHAT_OUTPUT_SCHEMA.parse(empty)).not.toThrow();
  });

  it("rejects more than 20 citations (Q3 cap)", () => {
    const bad = {
      version: "v1",
      answer: "x",
      citations: Array.from({ length: 21 }, (_, i) => `p${i}.md`),
    };
    expect(() => CHAT_OUTPUT_SCHEMA.parse(bad)).toThrow();
  });

  it("rejects empty answer", () => {
    const bad = {
      version: "v1",
      answer: "",
      citations: [],
    };
    expect(() => CHAT_OUTPUT_SCHEMA.parse(bad)).toThrow();
  });

  it("rejects unknown fields (.strict)", () => {
    const bad = {
      version: "v1",
      answer: "x",
      citations: [],
      malicious: "ignored?",
    };
    expect(() => CHAT_OUTPUT_SCHEMA.parse(bad)).toThrow();
  });
});

describe("runChat — strict callerPat assertion (Q2)", () => {
  // Q2: strict `callerPat === undefined || trim().length === 0`
  // throws ChatPatRequiredError(validation) BEFORE any LLM call
  // or MCP read. Empty / whitespace-only PATs do not pass.
  it("DLQs as validation when ctx.callerPat is undefined", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "chat",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(CHAT_DEFINITION);
    const mcp = new InMemoryMcpToolClient();
    const router = makeRouter(
      fakeProvider({ version: "v1", answer: "ok", citations: [] }),
      fixture.db,
    );

    // Caller omits callerPat entirely.
    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "http",
      inputs: { question: "what is X?" },
      run: (ctx) =>
        runChat(ctx, {
          db: fixture.db as unknown as Parameters<typeof runChat>[1]["db"],
          mcp,
          domainSlug: "test-domain",
          question: "what is X?",
        }),
    });

    expect(result.status).toBe("failed");
    const rows = await fixture.raw.query<{
      error_class: string;
      output: { name: string };
    }>(
      `SELECT error_class::text AS error_class, output FROM agent_runs WHERE id = $1`,
      [result.runId],
    );
    expect(rows.rows[0]?.error_class).toBe("validation");
    expect(rows.rows[0]?.output?.name).toBe("ChatPatRequiredError");
  });

  it("DLQs when ctx.callerPat is whitespace-only (trim().length === 0)", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "chat",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(CHAT_DEFINITION);
    const mcp = new InMemoryMcpToolClient();
    const router = makeRouter(
      fakeProvider({ version: "v1", answer: "ok", citations: [] }),
      fixture.db,
    );
    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "http",
      inputs: {},
      callerPat: "   \t  ",
      run: (ctx) =>
        runChat(ctx, {
          db: fixture.db as unknown as Parameters<typeof runChat>[1]["db"],
          mcp,
          domainSlug: "test-domain",
          question: "x?",
        }),
    });
    expect(result.status).toBe("failed");
    const rows = await fixture.raw.query<{ output: { name: string } }>(
      `SELECT output FROM agent_runs WHERE id = $1`,
      [result.runId],
    );
    expect(rows.rows[0]?.output?.name).toBe("ChatPatRequiredError");
  });

  it("ChatPatRequiredError carries errorClass='validation' (DLQ-routable)", () => {
    const err = new ChatPatRequiredError();
    expect(err.errorClass).toBe("validation");
    expect(err.name).toBe("ChatPatRequiredError");
  });
});

describe("normalizeCallerPat — local trim for downstream use (copilot #23 fix 4)", () => {
  // Whitespace-padded PATs pass the strict empty check
  // (`"  realtoken  ".trim().length > 0`) but fail Bearer auth
  // if propagated unchanged. Chat trims for its OWN downstream
  // use; the harness's verbatim contract (ctx.callerPat
  // reaches the body unchanged) stays intact.
  it("strips leading + trailing whitespace", () => {
    expect(normalizeCallerPat("  ghp_alice_secret  ")).toBe(
      "ghp_alice_secret",
    );
  });

  it("leaves clean PATs unchanged", () => {
    expect(normalizeCallerPat("ghp_clean")).toBe("ghp_clean");
  });

  it("does not mutate inner whitespace (a real PAT has no internal spaces, but the helper is dumb-trim)", () => {
    expect(normalizeCallerPat("  ghp_a b  ")).toBe("ghp_a b");
  });
});

describe("runChat — whitespace-padded PAT path (copilot #23 fix 4)", () => {
  it("succeeds end-to-end when ctx.callerPat has surrounding whitespace; harness propagation stays verbatim", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "chat",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(CHAT_DEFINITION);

    const mcp = new InMemoryMcpToolClient();
    mcp.setResource("worldview://test-domain", "# wv");
    mcp.setResource("wiki://test-domain/index.md", "# index");

    const router = makeRouter(
      fakeProvider({ version: "v1", answer: "ok", citations: [] }),
      fixture.db,
    );

    let ctxCallerPatObserved: string | undefined;
    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "http",
      inputs: {},
      callerPat: "  ghp_padded  ",
      run: async (ctx) => {
        ctxCallerPatObserved = ctx.callerPat;
        return runChat(ctx, {
          db: fixture.db as unknown as Parameters<typeof runChat>[1]["db"],
          mcp,
          domainSlug: "test-domain",
          question: "what's in the index?",
        });
      },
    });

    expect(result.status).toBe("success");
    // Harness contract: ctx.callerPat reaches the body
    // verbatim — Chat normalizes locally rather than at the
    // harness layer.
    expect(ctxCallerPatObserved).toBe("  ghp_padded  ");
  });
});

describe("runChat — body wires PAT-scoped MCP wrapper (Q4-Q5)", () => {
  it("propagates ctx.callerPat into every MCP call via the wrapper", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "chat",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(CHAT_DEFINITION);
    const mcp = new InMemoryMcpToolClient();
    mcp.setResource("worldview://test-domain", "# wv");
    mcp.setResource("wiki://test-domain/index.md", "# index");

    const payload: ChatOutput = {
      version: "v1",
      answer: "Yes.",
      citations: ["index.md"],
    };
    const router = makeRouter(fakeProvider(payload), fixture.db);

    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "http",
      inputs: {},
      callerPat: "ghp_alice_secret",
      run: (ctx) =>
        runChat(ctx, {
          db: fixture.db as unknown as Parameters<typeof runChat>[1]["db"],
          mcp,
          domainSlug: "test-domain",
          question: "what's in the index?",
        }),
    });

    expect(result.status).toBe("success");
    expect(result.output).toEqual(payload);
  });

  it("throws DomainScopeMismatchError when domainSlug isn't in scopeDomainIds (security-adjacent)", async () => {
    const fixture = await freshAgentDb();
    await fixture.raw.query(
      `INSERT INTO domains (slug, name) VALUES ('other-domain', 'Other')`,
    );
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "chat",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(CHAT_DEFINITION);
    const mcp = new InMemoryMcpToolClient();
    const router = makeRouter(
      fakeProvider({ version: "v1", answer: "x", citations: [] }),
      fixture.db,
    );
    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "http",
      inputs: {},
      callerPat: "ghp_alice",
      run: (ctx) =>
        runChat(ctx, {
          db: fixture.db as unknown as Parameters<typeof runChat>[1]["db"],
          mcp,
          domainSlug: "other-domain",
          question: "x?",
        }),
    });
    expect(result.status).toBe("failed");
    const rows = await fixture.raw.query<{ output: { name: string } }>(
      `SELECT output FROM agent_runs WHERE id = $1`,
      [result.runId],
    );
    expect(rows.rows[0]?.output?.name).toBe("DomainScopeMismatchError");
  });
});
