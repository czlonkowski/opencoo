/**
 * `listAvailableTemplateSlugs` tests (PR-O3, phase-a appendix #7).
 *
 * Boot-time call from production-composition.ts:
 *
 *     await listAvailableTemplateSlugs({ mcp, fallbackSlugs, logger })
 *
 * Returns the closed list of n8n template slugs the Surfacer LLM
 * is allowed to propose. When the n8n-mcp client is unreachable,
 * returns malformed shape, or returns an empty array, the function
 * falls back to the vendored `builderSkills.map(s => s.slug)`
 * baseline so Surfacer remains registered (rather than omitted
 * entirely as in PR-N3 round-2 fix #2).
 *
 * Load-bearing assertions:
 *   1. Sorted + deduped output.
 *   2. Every failure mode (null mcp, missing callTool, throw,
 *      malformed shape, empty result) returns the fallback array
 *      verbatim.
 *   3. Bearer-shaped tokens in error messages are scrubbed before
 *      logging (THREAT-MODEL §3.6 invariant 11; same discipline
 *      as the underlying HttpMcpToolClient).
 *   4. `surfacer.template_catalog_n8n_mcp_unreachable` /
 *      `_empty` warns are emitted at the right times so the
 *      operator sees why Surfacer is using the vendored fallback.
 */
import { describe, expect, it } from "vitest";

import type { Logger } from "@opencoo/shared/logger";

import {
  listAvailableTemplateSlugs,
  type McpToolCallClient,
} from "../src/list-templates.js";

interface CapturedLog {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data?: Record<string, unknown> | undefined;
}

function makeRecordingLogger(): {
  logger: Logger;
  records: CapturedLog[];
} {
  const records: CapturedLog[] = [];
  const push =
    (level: CapturedLog["level"]) =>
    (message: string, data?: Record<string, unknown>): void => {
      records.push({ level, message, data });
    };
  const logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  } as unknown as Logger;
  return { logger, records };
}

/** Build a minimal McpToolCallClient stub that returns a canned
 *  result from callTool. The stub deliberately omits readResource
 *  / listResources — the production HttpMcpToolClient implements
 *  the full McpToolClient surface, but listAvailableTemplateSlugs
 *  only consumes callTool. */
function makeStubClient(
  callToolImpl: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>,
): McpToolCallClient {
  return { callTool: callToolImpl };
}

const FALLBACK = ["heartbeat-digest", "lint-pages", "dispatch-task"] as const;

describe("listAvailableTemplateSlugs — happy path", () => {
  it("returns sorted + deduped slugs from the n8n-mcp categories response", async () => {
    // The n8n-mcp `search_templates` patterns response shape:
    //   { content: [{ type: "text", text: <jsonString> }] }
    // where jsonString parses to an object with `categories: [...]`
    // — each category has a `category` field that is a stable
    // identifier (e.g. "ai_automation", "webhook_processing").
    const mcp = makeStubClient(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            templateCount: 2352,
            categories: [
              { category: "webhook_processing" },
              { category: "ai_automation" },
              { category: "data_sync" },
              { category: "scheduling" },
              { category: "email_automation" },
            ],
          }),
        },
      ],
    }));
    const { logger } = makeRecordingLogger();
    const result = await listAvailableTemplateSlugs({
      mcp,
      fallbackSlugs: FALLBACK,
      logger,
    });
    expect([...result]).toEqual([
      "ai_automation",
      "data_sync",
      "email_automation",
      "scheduling",
      "webhook_processing",
    ]);
  });

  it("dedupes repeated category slugs", async () => {
    const mcp = makeStubClient(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            categories: [
              { category: "webhook_processing" },
              { category: "webhook_processing" },
              { category: "ai_automation" },
            ],
          }),
        },
      ],
    }));
    const { logger } = makeRecordingLogger();
    const result = await listAvailableTemplateSlugs({
      mcp,
      fallbackSlugs: FALLBACK,
      logger,
    });
    expect([...result]).toEqual(["ai_automation", "webhook_processing"]);
  });

  it("invokes search_templates with the patterns mode + a sane limit", async () => {
    const calls: Array<{
      name: string;
      args?: Record<string, unknown>;
    }> = [];
    const mcp = makeStubClient(async (name, args) => {
      calls.push({ name, ...(args !== undefined ? { args } : {}) });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ categories: [{ category: "ai_automation" }] }),
          },
        ],
      };
    });
    const { logger } = makeRecordingLogger();
    await listAvailableTemplateSlugs({
      mcp,
      fallbackSlugs: FALLBACK,
      logger,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("search_templates");
    expect(calls[0]?.args?.searchMode).toBe("patterns");
    // limit is bounded so a runaway response can't blow up the
    // Surfacer system prompt.
    expect(typeof calls[0]?.args?.limit).toBe("number");
    expect(calls[0]?.args?.limit).toBeGreaterThan(0);
    expect(calls[0]?.args?.limit).toBeLessThanOrEqual(100);
  });
});

describe("listAvailableTemplateSlugs — fallback paths", () => {
  it("returns fallback when mcp client is null (no log expected)", async () => {
    const { logger, records } = makeRecordingLogger();
    const result = await listAvailableTemplateSlugs({
      mcp: null,
      fallbackSlugs: FALLBACK,
      logger,
    });
    expect([...result]).toEqual([...FALLBACK]);
    // null mcp is the EXPECTED state when N8N_MCP_BASE_URL is
    // unset — no warn needed; the orchestrator already logged
    // `n8n_mcp.unavailable` upstream.
    const warns = records.filter((r) => r.level === "warn");
    expect(warns).toHaveLength(0);
  });

  it("returns fallback when callTool is undefined (no log expected)", async () => {
    // A client without callTool support (e.g. an
    // older McpToolClient). Same EXPECTED-state semantics as the
    // null branch.
    const mcp = {} as unknown as McpToolCallClient;
    const { logger, records } = makeRecordingLogger();
    const result = await listAvailableTemplateSlugs({
      mcp,
      fallbackSlugs: FALLBACK,
      logger,
    });
    expect([...result]).toEqual([...FALLBACK]);
    expect(records.filter((r) => r.level === "warn")).toHaveLength(0);
  });

  it("returns fallback + logs `surfacer.template_catalog_n8n_mcp_unreachable` when callTool throws", async () => {
    const mcp = makeStubClient(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:5678");
    });
    const { logger, records } = makeRecordingLogger();
    const result = await listAvailableTemplateSlugs({
      mcp,
      fallbackSlugs: FALLBACK,
      logger,
    });
    expect([...result]).toEqual([...FALLBACK]);
    const warn = records.find(
      (r) =>
        r.level === "warn" &&
        r.message === "surfacer.template_catalog_n8n_mcp_unreachable",
    );
    expect(warn).toBeDefined();
    expect(warn?.data?.fallback_count).toBe(FALLBACK.length);
  });

  it("returns fallback + logs `surfacer.template_catalog_n8n_mcp_empty` when search_templates returns 0 templates", async () => {
    const mcp = makeStubClient(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ categories: [] }),
        },
      ],
    }));
    const { logger, records } = makeRecordingLogger();
    const result = await listAvailableTemplateSlugs({
      mcp,
      fallbackSlugs: FALLBACK,
      logger,
    });
    expect([...result]).toEqual([...FALLBACK]);
    const warn = records.find(
      (r) =>
        r.level === "warn" &&
        r.message === "surfacer.template_catalog_n8n_mcp_empty",
    );
    expect(warn).toBeDefined();
  });

  it("returns fallback when response shape is malformed (null result)", async () => {
    const mcp = makeStubClient(async () => null);
    const { logger, records } = makeRecordingLogger();
    const result = await listAvailableTemplateSlugs({
      mcp,
      fallbackSlugs: FALLBACK,
      logger,
    });
    expect([...result]).toEqual([...FALLBACK]);
    // An empty parse result is treated as the empty case — operator
    // sees the empty warn so they can investigate.
    const warns = records.filter((r) => r.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
  });

  it("returns fallback when response shape is malformed (string instead of object)", async () => {
    const mcp = makeStubClient(async () => "definitely not an mcp response");
    const { logger, records } = makeRecordingLogger();
    const result = await listAvailableTemplateSlugs({
      mcp,
      fallbackSlugs: FALLBACK,
      logger,
    });
    expect([...result]).toEqual([...FALLBACK]);
    const warns = records.filter((r) => r.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
  });

  it("returns fallback when text content is not valid JSON", async () => {
    const mcp = makeStubClient(async () => ({
      content: [{ type: "text", text: "<<not json>>" }],
    }));
    const { logger, records } = makeRecordingLogger();
    const result = await listAvailableTemplateSlugs({
      mcp,
      fallbackSlugs: FALLBACK,
      logger,
    });
    expect([...result]).toEqual([...FALLBACK]);
    const warns = records.filter((r) => r.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
  });

  it("returns empty array when fallback is empty AND n8n-mcp throws (Surfacer remains omitted downstream)", async () => {
    const mcp = makeStubClient(async () => {
      throw new Error("upstream down");
    });
    const { logger } = makeRecordingLogger();
    const result = await listAvailableTemplateSlugs({
      mcp,
      fallbackSlugs: [],
      logger,
    });
    // Empty array → caller treats as "no template catalog" and
    // omits Surfacer per round-2 fix #2 of PR-N3.
    expect([...result]).toEqual([]);
  });

  it("scrubs bearer-shaped tokens in error messages before logging (THREAT-MODEL §3.6 #11)", async () => {
    // Simulate an upstream that echoes the inbound bearer.
    const mcp = makeStubClient(async () => {
      throw new Error(
        "request failed: Authorization: Bearer abcdef1234567890ghijklmnopqrstuv",
      );
    });
    const { logger, records } = makeRecordingLogger();
    await listAvailableTemplateSlugs({
      mcp,
      fallbackSlugs: FALLBACK,
      logger,
    });
    for (const r of records) {
      const serialized = JSON.stringify(r);
      expect(serialized).not.toContain("abcdef1234567890ghijklmnopqrstuv");
    }
  });
});

describe("listAvailableTemplateSlugs — alternative response shapes", () => {
  // The n8n-mcp tool surface may evolve. Tests below pin defensive
  // parsing against shapes the function MUST also accept (or at
  // least fail gracefully on) so a future tool upgrade doesn't
  // silently break Surfacer activation.
  it("accepts an `items` array with per-template slug fields when the API returns one", async () => {
    // A future n8n-mcp release might return per-template slugs
    // directly; the parser walks `items[].slug` as a secondary
    // extraction path.
    const mcp = makeStubClient(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            items: [
              { slug: "send-slack-message" },
              { slug: "create-asana-task" },
            ],
          }),
        },
      ],
    }));
    const { logger } = makeRecordingLogger();
    const result = await listAvailableTemplateSlugs({
      mcp,
      fallbackSlugs: FALLBACK,
      logger,
    });
    expect([...result]).toEqual(["create-asana-task", "send-slack-message"]);
  });
});
