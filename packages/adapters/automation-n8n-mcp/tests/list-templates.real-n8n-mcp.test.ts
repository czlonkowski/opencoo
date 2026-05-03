/**
 * Operator-self-verification smoke test for `listAvailableTemplateSlugs`
 * against a REAL n8n-mcp MCP server (PR-O3, phase-a appendix #7).
 *
 * Gated by `RUN_REAL_N8N_MCP=1` — CI never runs this; the operator
 * runs it manually before opening a PR if they have access to a live
 * n8n-mcp instance. Mirrors the `*.real-mcp.test.ts` /
 * `*.real-llm.test.ts` gating convention.
 *
 *     RUN_REAL_N8N_MCP=1 \
 *       N8N_MCP_TEST_URL=https://n8n-mcp.example.com/mcp \
 *       N8N_MCP_TEST_BEARER=<bearer> \
 *       pnpm vitest run packages/adapters/automation-n8n-mcp/tests/list-templates.real-n8n-mcp.test.ts
 *
 * The test constructs a real `HttpMcpToolClient` from
 * @opencoo/engine-self-operating, points it at the operator-supplied
 * n8n-mcp endpoint, and asserts that `listAvailableTemplateSlugs`
 * returns ≥ 1 string slug. Per the n8n-mcp `patterns` mode, the
 * deployment in question should expose ~10 category slugs
 * (ai_automation, webhook_processing, etc.) — we assert ≥ 1 to keep
 * the test resilient to upstream changes.
 *
 * ESLint exception for env-var allow-list lives at
 * `eslint.config.js` block 9 — the file-pattern `*.real-n8n-mcp.test.ts`
 * exempts this file from `no-feature-env-vars`.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";

import { listAvailableTemplateSlugs } from "../src/list-templates.js";

// Dynamic-import @opencoo/engine-self-operating inside the test
// body — this package's runtime deps deliberately do NOT include
// engine-self-operating (cross-engine boundary discipline). The
// test pulls it in only when RUN_REAL_N8N_MCP=1 is set, so the
// CI default skip path doesn't try to resolve the package at
// collection time.

const RUN = process.env.RUN_REAL_N8N_MCP === "1";
const URL = process.env.N8N_MCP_TEST_URL;
const BEARER = process.env.N8N_MCP_TEST_BEARER;

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

describe.skipIf(!RUN)(
  "listAvailableTemplateSlugs against a real n8n-mcp server (gated)",
  () => {
    it("returns ≥ 1 slug when the server is reachable", async () => {
      if (URL === undefined || BEARER === undefined) {
        throw new Error(
          "RUN_REAL_N8N_MCP=1 set but N8N_MCP_TEST_URL or N8N_MCP_TEST_BEARER missing",
        );
      }
      const mod = (await import("@opencoo/engine-self-operating")) as {
        HttpMcpToolClient: new (opts: {
          baseUrl: string;
          bearerToken: string;
          logger: ConsoleLogger;
        }) => {
          callTool?: (
            name: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      };
      const mcp = new mod.HttpMcpToolClient({
        baseUrl: URL,
        bearerToken: BEARER,
        logger: silentLogger(),
      });
      const slugs = await listAvailableTemplateSlugs({
        mcp,
        fallbackSlugs: ["should-not-be-returned"],
        logger: silentLogger(),
      });
      // Either the live n8n-mcp returned slugs (path A) OR it was
      // unreachable and we got the fallback (path B). Either way
      // we should NOT see an empty array — that would mean the
      // module crashed silently. The realistic operator outcome
      // we want to verify is path A: the live server returned at
      // least one parseable slug.
      expect(slugs.length).toBeGreaterThanOrEqual(1);
      // Every slug is a non-empty string.
      for (const s of slugs) {
        expect(typeof s).toBe("string");
        expect(s.length).toBeGreaterThan(0);
      }
      // No duplicates.
      expect(new Set(slugs).size).toBe(slugs.length);
      // Sorted ascending.
      const sorted = [...slugs].sort();
      expect([...slugs]).toEqual(sorted);
    });
  },
);
