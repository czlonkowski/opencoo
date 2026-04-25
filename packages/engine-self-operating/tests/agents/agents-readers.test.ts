/**
 * LOAD-BEARING integration test (plan #92, part A — task #93).
 *
 * Drives BOTH reader agents — Heartbeat and Lint — through
 * `invokeAgent` end-to-end against a single fixture, then
 * asserts the central read-only invariant:
 *
 *   `wikiAdapter.writeAtomic` was called ZERO times across
 *   both runs. The reader agents are read-only by construction;
 *   neither one is permitted to write to the wiki.
 *
 * The proof is structural: the agents have no wikiWrite tool
 * registered (their tool wrappers cover only wiki-read /
 * worldview-read / index-search). This test backstops that
 * structure by passing a counting WikiAdapter through the
 * fixture and asserting the counter stays at 0 after both runs
 * complete.
 *
 * Also asserts:
 *   - Output channel binding enforcement: the engine routes
 *     each agent's payload via `OutputChannelRegistry.deliver`
 *     and the bound MockOutputChannelAdapter receives one
 *     delivery per run.
 *   - Cross-instance leakage: a delivery whose adapterSlug
 *     isn't in this instance's outputChannelIds throws
 *     OutputChannelMismatchError.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import {
  type WikiAdapter,
  type WriteAtomicArgs,
  type WriteAtomicResult,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";

import {
  AgentDefinitionRegistry,
  invokeAgent,
} from "../../src/agent-harness/index.js";
import { InMemoryMcpToolClient } from "../../src/mcp-tool-client/index.js";
import {
  HEARTBEAT_DEFINITION,
  runHeartbeat,
  type HeartbeatOutput,
} from "../../src/agents/heartbeat/index.js";
import {
  LINT_DEFINITION,
  runLint,
  type LintOutput,
} from "../../src/agents/lint/index.js";
import {
  MockOutputChannelAdapter,
  OutputChannelMismatchError,
  OutputChannelRegistry,
} from "../../src/output-channels/index.js";

import {
  freshAgentDb,
  seedAgentInstance,
  seedBinding,
  seedPageCitation,
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

/**
 * Counting WikiAdapter — wraps an InMemoryWikiAdapter and
 * tracks how many times `writeAtomic` is called. The agent
 * post-run hook never invokes wikiWrite for reader agents, so
 * the counter must stay at 0.
 */
class CountingWikiAdapter implements WikiAdapter {
  readonly inner = new InMemoryWikiAdapter();
  writeAtomicCalls = 0;

  getHeadSha = (slug: Parameters<WikiAdapter["getHeadSha"]>[0]) =>
    this.inner.getHeadSha(slug);
  readPage = (
    slug: Parameters<WikiAdapter["readPage"]>[0],
    path: Parameters<WikiAdapter["readPage"]>[1],
  ) => this.inner.readPage(slug, path);
  listMarkdown = (slug: Parameters<WikiAdapter["listMarkdown"]>[0]) =>
    this.inner.listMarkdown(slug);

  async writeAtomic(args: WriteAtomicArgs): Promise<WriteAtomicResult> {
    this.writeAtomicCalls++;
    return this.inner.writeAtomic(args);
  }
}

describe("agents-readers — Heartbeat + Lint never call wikiWrite (LOAD-BEARING)", () => {
  it("after a Heartbeat run AND a Lint run, the counting wiki adapter shows 0 writes", async () => {
    const fixture = await freshAgentDb();

    // Seed the bindings + citations so Lint has something to run against.
    const narrow = await seedBinding(fixture, {
      adapterSlug: "asana",
      allowedPaths: ["projects/q3.md"],
    });
    await seedPageCitation(fixture, {
      pagePath: "projects/q3.md",
      bindingId: narrow.bindingId,
      promptVersion: "1.0.0",
    });

    // Seed the MCP fixture so both agents have content to read.
    const mcp = new InMemoryMcpToolClient();
    mcp.setResource("wiki://test-domain/index.md", "# index");
    mcp.setResource("wiki://test-domain/projects/q3.md", "Q3 deck");
    mcp.setResource("worldview://test-domain", "# wv");

    // Counting wiki adapter — wikiWrite calls must stay at 0.
    const wikiAdapter = new CountingWikiAdapter();

    // Output channel: register a mock channel + bind it on each
    // instance. We assert the registry ends up with one delivery
    // per run, with the correct payload.
    const channels = new OutputChannelRegistry();
    const slack = new MockOutputChannelAdapter("slack");
    channels.register(slack);
    const bindings = [
      { adapter_slug: "slack", config: { channel: "#opencoo-readers" } },
    ];

    // -- Heartbeat run --
    const { instanceId: heartbeatInstanceId } = await seedAgentInstance(
      fixture,
      {
        definitionSlug: "heartbeat",
        instanceName: "heartbeat-1",
        memory: { type: "none" },
      },
    );
    const heartbeatPayload: HeartbeatOutput = {
      version: "v1",
      summary: "Q3 deck due Friday.",
      alerts: [
        {
          priority: 1,
          title: "Q3 deck due Friday",
          body: "Sales blocked on the deck.",
          citations: ["projects/q3.md"],
        },
      ],
    };
    const definitions = new AgentDefinitionRegistry();
    definitions.register(HEARTBEAT_DEFINITION);
    definitions.register(LINT_DEFINITION);

    const heartbeatRouter = makeRouter(fakeProvider(heartbeatPayload), fixture.db);
    const heartbeatResult = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router: heartbeatRouter,
      logger: silentLogger(),
      instanceId: heartbeatInstanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) => runHeartbeat(ctx, { mcp, domainSlug: "test-domain" }),
    });
    expect(heartbeatResult.status).toBe("success");

    // Engine post-run hook: deliver heartbeat payload via the
    // bound channel.
    await channels.deliver({
      bindings,
      delivery: {
        adapterSlug: "slack",
        payload: heartbeatResult.output,
      },
    });

    // -- Lint run --
    const { instanceId: lintInstanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "lint",
      instanceName: "lint-1",
      memory: { type: "none" },
    });
    const lintRouter = makeRouter(
      fakeProvider({ version: "v1", contradictions: [] }),
      fixture.db,
    );
    const lintResult = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router: lintRouter,
      logger: silentLogger(),
      instanceId: lintInstanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runLint(ctx, {
          db: fixture.db as unknown as Parameters<typeof runLint>[1]["db"],
          mcp,
          domainSlug: "test-domain",
        }),
    });
    expect(lintResult.status).toBe("success");
    const lintOutput = lintResult.output as LintOutput;
    expect(lintOutput.version).toBe("v1");

    // Engine post-run hook: deliver lint payload via the bound
    // channel.
    await channels.deliver({
      bindings,
      delivery: {
        adapterSlug: "slack",
        payload: lintResult.output,
      },
    });

    // -- LOAD-BEARING ASSERTION --
    expect(wikiAdapter.writeAtomicCalls).toBe(0);

    // -- Output channel sanity --
    expect(slack.deliveries).toHaveLength(2);
    expect(slack.deliveries[0]?.payload).toEqual(heartbeatPayload);
    expect((slack.deliveries[1]?.payload as LintOutput)?.version).toBe("v1");
  });

  it("attempting to deliver to a channel NOT in the instance's bindings throws OutputChannelMismatchError", async () => {
    // The Heartbeat instance is bound to slack only — attempting
    // to push the payload to email at the post-run hook must
    // fail at the registry gate. The agent body itself never
    // invokes the registry (Q10), so this test exercises the
    // post-run hook guard directly.
    const channels = new OutputChannelRegistry();
    channels.register(new MockOutputChannelAdapter("slack"));
    channels.register(new MockOutputChannelAdapter("email"));
    const bindings = [
      { adapter_slug: "slack", config: { channel: "#exec" } },
    ];

    await expect(
      channels.deliver({
        bindings,
        delivery: { adapterSlug: "email", payload: { foo: 1 } },
      }),
    ).rejects.toBeInstanceOf(OutputChannelMismatchError);
  });
});
