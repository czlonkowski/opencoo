/**
 * `HttpMcpToolClient` real-server smoke (PR-N3, phase-a appendix
 * #6). Gated on `RUN_REAL_MCP=1` — CI skips by default; operators
 * run this against a live gitea-wiki-mcp-server during pilot
 * stand-up to verify the transport end-to-end.
 *
 * Required env (when RUN_REAL_MCP=1):
 *   - `MCP_TEST_URL`      — full MCP endpoint URL, e.g.
 *                           `http://localhost:3000/mcp`
 *   - `MCP_TEST_BEARER`   — static bearer matching the server's
 *                           MCP_BEARER_TOKEN
 *
 * Usage (from a terminal with the gitea-wiki-mcp-server up):
 *   RUN_REAL_MCP=1 \
 *   MCP_TEST_URL=http://localhost:3000/mcp \
 *   MCP_TEST_BEARER=$(openssl rand -hex 32) \
 *     pnpm --filter @opencoo/engine-self-operating test http.real-mcp
 *
 * NOT a CI pin — this test exists so an operator can prove their
 * deployment can talk to the gitea-wiki-mcp-server before the
 * scheduled-agent path activates. Failure modes (non-2xx, timeout,
 * auth reject) bubble through the same `McpHttpError` surface
 * production code sees.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";

import { HttpMcpToolClient } from "../../src/mcp-tool-client/index.js";

const RUN_REAL_MCP = process.env["RUN_REAL_MCP"] === "1";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

describe.skipIf(!RUN_REAL_MCP)(
  "HttpMcpToolClient — real gitea-wiki-mcp-server (RUN_REAL_MCP=1)",
  () => {
    it("listResources() against the real server returns at least one URI", async () => {
      const baseUrl = process.env["MCP_TEST_URL"];
      const bearerToken = process.env["MCP_TEST_BEARER"];
      if (baseUrl === undefined || bearerToken === undefined) {
        throw new Error(
          "RUN_REAL_MCP=1 requires MCP_TEST_URL + MCP_TEST_BEARER",
        );
      }
      const client = new HttpMcpToolClient({
        baseUrl,
        bearerToken,
        logger: silentLogger(),
      });
      const uris = await client.listResources();
      expect(uris.length).toBeGreaterThan(0);
    });

    it("readResource() against one of the listed URIs returns a non-empty string", async () => {
      const baseUrl = process.env["MCP_TEST_URL"];
      const bearerToken = process.env["MCP_TEST_BEARER"];
      if (baseUrl === undefined || bearerToken === undefined) {
        throw new Error(
          "RUN_REAL_MCP=1 requires MCP_TEST_URL + MCP_TEST_BEARER",
        );
      }
      const client = new HttpMcpToolClient({
        baseUrl,
        bearerToken,
        logger: silentLogger(),
      });
      const uris = await client.listResources();
      const first = uris[0];
      if (first === undefined) {
        throw new Error("real-mcp: server returned 0 resources");
      }
      const body = await client.readResource(first);
      expect(typeof body).toBe("string");
      expect(body.length).toBeGreaterThan(0);
    });
  },
);
