/**
 * LOAD-BEARING integration test (plan #92, part A — task #93).
 *
 * Drives BOTH reader agents — Heartbeat and Lint — through
 * `invokeAgent` end-to-end against a single fixture, then
 * asserts the central read-only invariant via the tool-call
 * ledger:
 *
 *   `agent_runs.tool_calls` for every reader-agent run contains
 *   ONLY read-side tool names. No `wiki.write*`, `wiki.replace*`,
 *   `wiki.delete*`, `wiki.commit*`, or other writer-shape names
 *   appear in the persisted JSONB. The reader agents are
 *   read-only by construction; neither has a writer tool wrapper
 *   in `src/agents/tools/`.
 *
 * The deny-list throws `AgentDenyListError` if any of the named
 * destructive tools is invoked (prevention); this test pins
 * their absence in the ledger after the runs (verification).
 * Together: prevention + verification.
 *
 * The earlier shape — instantiating a `CountingWikiAdapter`
 * spy and asserting `writeAtomicCalls === 0` — passed
 * vacuously because the spy was never wired into the harness's
 * tool-dispatch path (the readers don't take a WikiAdapter).
 * The ledger-based assertion is the actual structural pin.
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
 * A name is "writer-shape" if it could plausibly mutate wiki
 * state. The reader-agent tool wrappers only emit
 * `worldview.read`, `index.search`, `wiki.read_page` — anything
 * matching one of these prefixes/suffixes is a regression.
 * Combined with the deny-list (which throws at dispatch time),
 * this gives prevention + verification.
 */
const WRITER_TOOL_PATTERNS: readonly RegExp[] = [
  /^wiki\.write/,
  /^wiki\.replace/,
  /^wiki\.delete/,
  /^wiki\.commit/,
  /^wiki\.append/,
  /^wiki\.force_push/,
  /^mcp\.write/,
  /^output_channel_deliver/, // Q10: not a tool, ledger-pinned absent.
];

function isWriterToolName(name: string): boolean {
  return WRITER_TOOL_PATTERNS.some((re) => re.test(name));
}

describe("agents-readers — Heartbeat + Lint never call wikiWrite (LOAD-BEARING)", () => {
  it("after a Heartbeat run AND a Lint run, agent_runs.tool_calls contains no writer-shape tool names", async () => {
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

    // -- LOAD-BEARING ASSERTION (ledger-based) --
    // Pull both runs' tool_calls from agent_runs.tool_calls and
    // assert no entry's `name` matches a writer-shape pattern.
    // The deny-list at the harness's tool-dispatch path would
    // throw `AgentDenyListError` if a destructive tool name was
    // invoked (prevention); this assertion pins their ABSENCE
    // in the persisted ledger (verification).
    const ledgerRows = await fixture.raw.query<{
      id: string;
      definition_slug: string;
      tool_calls: Array<{ name: string }>;
    }>(
      `SELECT id::text AS id, definition_slug, tool_calls FROM agent_runs WHERE id IN ($1::uuid, $2::uuid)`,
      [heartbeatResult.runId, lintResult.runId],
    );
    expect(ledgerRows.rows).toHaveLength(2);
    const allToolCalls = ledgerRows.rows.flatMap((r) => r.tool_calls);
    // Every recorded tool name must be a known reader name —
    // anything writer-shape is a regression. Failures surface
    // as the violating name(s) so the diagnostic points right
    // at the offending call site.
    const violatingNames = allToolCalls
      .map((c) => c.name)
      .filter(isWriterToolName);
    expect(violatingNames).toEqual([]);
    // Sanity: both runs DID call read-side tools. If the ledger
    // is empty the assertion above is still vacuous — pin that
    // we actually exercised the harness's dispatch path.
    expect(allToolCalls.length).toBeGreaterThan(0);
    const knownReaderNames = new Set([
      "worldview.read",
      "index.search",
      "wiki.read_page",
    ]);
    for (const c of allToolCalls) {
      expect(knownReaderNames.has(c.name)).toBe(true);
    }

    // -- Output channel sanity --
    expect(slack.deliveries).toHaveLength(2);
    expect(slack.deliveries[0]?.payload).toEqual(heartbeatPayload);
    expect((slack.deliveries[1]?.payload as LintOutput)?.version).toBe("v1");
  });

  // Red guard for the assertion itself — proves the
  // load-bearing assertion above isn't vacuous. If a future
  // refactor breaks `isWriterToolName` so it stops matching
  // writer names, this guard fires loudly.
  it("isWriterToolName flags every shape we care about (regression guard)", () => {
    for (const name of [
      "wiki.write_page",
      "wiki.write",
      "wiki.replace_page",
      "wiki.delete_repo",
      "wiki.delete",
      "wiki.commit",
      "wiki.append_log",
      "wiki.force_push",
      "mcp.write_resource",
      "output_channel_deliver",
    ]) {
      expect(isWriterToolName(name), `expected ${name} to be flagged`).toBe(true);
    }
    for (const name of [
      "worldview.read",
      "index.search",
      "wiki.read_page",
    ]) {
      expect(isWriterToolName(name), `expected ${name} NOT to be flagged`).toBe(false);
    }
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
