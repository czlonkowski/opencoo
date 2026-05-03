/**
 * `createProductionAgentRunners` tests (PR-N3, phase-a appendix
 * #6). The registry maps each schedulable definition slug
 * (`heartbeat`, `lint`, `surfacer`) to an `AgentRunner` closure
 * the AgentDispatcher invokes per scheduled job.
 *
 * Load-bearing assertions:
 *   1. The registry resolves runners for `heartbeat`, `lint`, and
 *      `surfacer` (the v0.1 scheduled-class agents).
 *   2. Unknown slugs (`chat`, `builder`, `nope`) return undefined.
 *      Chat + Builder are on-demand and are NEVER in the
 *      scheduled registry per architecture §9.4.
 *   3. Each runner closure, when invoked, calls through to its
 *      backing `runHeartbeat` / `runLint` / `runSurfacer`
 *      function with the production deps (db, mcp, router,
 *      logger) threaded plus the per-call `AgentRunContext`.
 *
 * The closures are invoked with vitest spies on the runner
 * functions; we don't run a real LLM here — that lives in the
 * `*.real-llm.test.ts` files.
 */
import { describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  InMemoryQueuePauser,
  LlmRouter,
  type LlmProvider,
} from "@opencoo/shared/llm-router";

import {
  AgentDefinitionRegistry,
  HEARTBEAT_DEFINITION,
  LINT_DEFINITION,
  SURFACER_DEFINITION,
  InMemoryMcpToolClient,
  type AgentRunContext,
} from "@opencoo/engine-self-operating";

import { createProductionAgentRunners } from "../src/provision/agent-runners.js";
import { tryComposeAgentRunnersFromEnv } from "../src/provision/production-composition.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function fakeProvider(): LlmProvider {
  return {
    generate: async () => ({
      text: '{"version":"v1","summary":"x","alerts":[]}',
      tokensIn: 1,
      tokensOut: 1,
    }),
  };
}

function makeDeps(): Parameters<typeof createProductionAgentRunners>[0] {
  // The registry doesn't actually open Postgres or the LLM router
  // when constructing closures — it only captures references. The
  // runner is invoked later with a synthetic AgentRunContext; the
  // backing run* functions are spied so we never reach a real DB.
  const router = new LlmRouter({
    db: {} as never,
    env: {},
    logger: silentLogger(),
    pauser: new InMemoryQueuePauser(),
    provider: fakeProvider(),
  });
  const mcp = new InMemoryMcpToolClient();
  const definitions = new AgentDefinitionRegistry();
  definitions.register(HEARTBEAT_DEFINITION);
  definitions.register(LINT_DEFINITION);
  definitions.register(SURFACER_DEFINITION);
  return {
    db: {} as never,
    mcp,
    router,
    logger: silentLogger(),
    definitions,
    // Tests use the override path so the closure doesn't try to
    // hit Postgres for slug resolution — production paths leave
    // `domainSlug` undefined and let the closure resolve from
    // `ctx.instance.scopeDomainIds[0]`.
    domainSlug: "test-domain",
    availableTemplateSlugs: ["asana-comment", "drive-watch"],
  };
}

function fakeCtx(slug: string): AgentRunContext {
  return {
    definition: { slug } as unknown as AgentRunContext["definition"],
    instance: {
      id: "00000000-0000-0000-0000-000000000001",
      definitionSlug: slug,
      scopeDomainIds: ["00000000-0000-0000-0000-000000000099"],
      locale: "en",
    } as unknown as AgentRunContext["instance"],
    runId: "00000000-0000-0000-0000-000000000010",
    spotlightedMemory: [],
    router: {} as unknown as AgentRunContext["router"],
    logger: silentLogger(),
    callTool: async (_name, fn) => fn(),
    recordToolCall: () => undefined,
  };
}

describe("createProductionAgentRunners — registry resolution", () => {
  it("returns runners for the three scheduled-class agents", () => {
    const registry = createProductionAgentRunners(makeDeps());
    expect(registry.get("heartbeat")).toBeTypeOf("function");
    expect(registry.get("lint")).toBeTypeOf("function");
    expect(registry.get("surfacer")).toBeTypeOf("function");
  });

  it("returns undefined for on-demand agents (chat, builder)", () => {
    // Chat + Builder are intentionally NOT in the scheduled
    // registry — they're invoked on-demand from the admin API,
    // not the cron scheduler.
    const registry = createProductionAgentRunners(makeDeps());
    expect(registry.get("chat")).toBeUndefined();
    expect(registry.get("builder")).toBeUndefined();
  });

  it("returns undefined for an unknown slug", () => {
    const registry = createProductionAgentRunners(makeDeps());
    expect(registry.get("does-not-exist")).toBeUndefined();
    expect(registry.get("")).toBeUndefined();
  });
});

describe("createProductionAgentRunners — runner closures dispatch through", () => {
  it("the heartbeat runner invokes runHeartbeat with the production deps", async () => {
    // Spy via dynamic import + vi.spyOn so we can substitute
    // without replacing the production module wholesale.
    const heartbeatModule = await import(
      "@opencoo/engine-self-operating"
    );
    const spy = vi
      .spyOn(heartbeatModule, "runHeartbeat")
      .mockResolvedValue({
        version: "v1",
        summary: "spied",
        alerts: [],
      } as Awaited<ReturnType<typeof heartbeatModule.runHeartbeat>>);

    const deps = makeDeps();
    const registry = createProductionAgentRunners(deps);
    const runner = registry.get("heartbeat");
    expect(runner).toBeTypeOf("function");
    await runner!(fakeCtx("heartbeat"));

    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0];
    expect(callArgs?.[1]?.mcp).toBe(deps.mcp);
    expect(callArgs?.[1]?.db).toBe(deps.db);
    expect(callArgs?.[1]?.domainSlug).toBe("test-domain");

    spy.mockRestore();
  });

  it("the lint runner invokes runLint with the production deps + the definitions registry", async () => {
    const lintModule = await import("@opencoo/engine-self-operating");
    const spy = vi.spyOn(lintModule, "runLint").mockResolvedValue({
      version: "v1",
      findings: [],
    } as Awaited<ReturnType<typeof lintModule.runLint>>);

    const deps = makeDeps();
    const registry = createProductionAgentRunners(deps);
    const runner = registry.get("lint");
    await runner!(fakeCtx("lint"));

    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0];
    expect(callArgs?.[1]?.mcp).toBe(deps.mcp);
    expect(callArgs?.[1]?.db).toBe(deps.db);
    expect(callArgs?.[1]?.definitions).toBe(deps.definitions);
    expect(callArgs?.[1]?.domainSlug).toBe("test-domain");

    spy.mockRestore();
  });

  it("the surfacer runner invokes runSurfacer with the production deps + availableTemplateSlugs", async () => {
    const surfacerModule = await import("@opencoo/engine-self-operating");
    const spy = vi
      .spyOn(surfacerModule, "runSurfacer")
      .mockResolvedValue({
        version: "v1",
        candidates: [],
        insertedCandidateIds: [],
      } as Awaited<ReturnType<typeof surfacerModule.runSurfacer>>);

    const deps = makeDeps();
    const registry = createProductionAgentRunners(deps);
    const runner = registry.get("surfacer");
    await runner!(fakeCtx("surfacer"));

    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0];
    expect(callArgs?.[1]?.mcp).toBe(deps.mcp);
    expect(callArgs?.[1]?.db).toBe(deps.db);
    expect(callArgs?.[1]?.domainSlug).toBe("test-domain");
    expect(callArgs?.[1]?.availableTemplateSlugs).toEqual([
      "asana-comment",
      "drive-watch",
    ]);

    spy.mockRestore();
  });
});

describe("tryComposeAgentRunnersFromEnv — boot-tolerance (PR-N3)", () => {
  it("returns null + logs `mcp_http.unavailable` when MCP_BEARER_TOKEN is unset", () => {
    const records: Array<{ level: string; message: string; data?: unknown }> = [];
    const logger = {
      debug: (m: string, d?: unknown) => records.push({ level: "debug", message: m, data: d }),
      info: (m: string, d?: unknown) => records.push({ level: "info", message: m, data: d }),
      warn: (m: string, d?: unknown) => records.push({ level: "warn", message: m, data: d }),
      error: (m: string, d?: unknown) => records.push({ level: "error", message: m, data: d }),
    } as unknown as Parameters<typeof tryComposeAgentRunnersFromEnv>[0]["logger"];
    const result = tryComposeAgentRunnersFromEnv({
      env: {}, // no MCP_BEARER_TOKEN
      router: {} as never,
      pgPool: {} as never,
      logger,
    });
    expect(result).toBeNull();
    const warn = records.find((r) => r.message === "mcp_http.unavailable");
    expect(warn).toBeDefined();
  });

  it("returns a populated registry when MCP_BEARER_TOKEN is set", () => {
    const result = tryComposeAgentRunnersFromEnv({
      env: { MCP_BEARER_TOKEN: "valid-token-1234567890" },
      router: {} as never,
      pgPool: {} as never,
      logger: silentLogger(),
    });
    expect(result).not.toBeNull();
    expect(result?.runners.get("heartbeat")).toBeTypeOf("function");
    expect(result?.runners.get("lint")).toBeTypeOf("function");
    expect(result?.runners.get("surfacer")).toBeTypeOf("function");
    expect(result?.runners.get("chat")).toBeUndefined();
    expect(result?.definitions.list().length).toBe(3);
  });

  it("exposes the LlmRouter on the bundle so the orchestrator can thread it into AgentDispatcher (round-2 fix #1 on PR #57)", async () => {
    // tryComposeAgentRunnersBundleFromEnv constructs both a
    // pg.Pool AND an LlmRouter, then captures both in the
    // returned bundle. The orchestrator reads `bundle.router`
    // and threads it into `engine-self-operating.start({
    // agentRouter })` so the AgentDispatcher's per-dispatch
    // ctx.router is the SAME instance the runner closures
    // captured. Without identity sharing, the dispatcher falls
    // back to its `({} as unknown) as LlmRouter` empty-object
    // cast and the first scheduled agent dispatch crashes.
    const composition = await import(
      "../src/provision/production-composition.js"
    );
    const bundle = composition.tryComposeAgentRunnersBundleFromEnv({
      env: {
        DATABASE_URL: "postgres://test:test@127.0.0.1:65535/none",
        MCP_BEARER_TOKEN: "static-bearer-do-not-leak",
      },
      logger: silentLogger(),
    });
    expect(bundle).not.toBeNull();
    // The bundle MUST expose a router that has the LlmRouter
    // surface — the dispatcher relies on `generateObject`.
    expect(bundle?.router).toBeDefined();
    expect(typeof bundle?.router.generateObject).toBe("function");
    expect(typeof bundle?.router.generateText).toBe("function");
    await bundle?.close();
  });

  it("never logs the bearer token (THREAT-MODEL §3.6 #11)", () => {
    const TOKEN = "super-secret-token-do-not-leak-1234567890";
    const records: Array<{ level: string; message: string; data?: unknown }> = [];
    const logger = {
      debug: (m: string, d?: unknown) => records.push({ level: "debug", message: m, data: d }),
      info: (m: string, d?: unknown) => records.push({ level: "info", message: m, data: d }),
      warn: (m: string, d?: unknown) => records.push({ level: "warn", message: m, data: d }),
      error: (m: string, d?: unknown) => records.push({ level: "error", message: m, data: d }),
    } as unknown as Parameters<typeof tryComposeAgentRunnersFromEnv>[0]["logger"];
    const result = tryComposeAgentRunnersFromEnv({
      env: { MCP_BEARER_TOKEN: TOKEN },
      router: {} as never,
      pgPool: {} as never,
      logger,
    });
    expect(result).not.toBeNull();
    for (const r of records) {
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });
});
