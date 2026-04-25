/**
 * `McpToolClient` — engine-self-operating port for read-only
 * access to MCP-style resources (wiki pages, worldview, index)
 * served by gitea-wiki-mcp-server.
 *
 * Per Q12 (planner): gitea-mcp runs out-of-process and the
 * production engine talks to it via `HttpMcpToolClient` (deferred
 * to PR 23+). v0.1 ships only the port shape + an in-memory
 * fixture so the agent body unit tests don't need the
 * gitea-wiki-mcp-server process running.
 *
 * The fixture is pure-data — the test wires up resources via
 * `setResource(uri, body)`, the agent calls `readResource(uri)`,
 * and unknown URIs throw `McpResourceNotFoundError` (the same
 * MCP-RPC `InvalidRequest` "resource not accessible" shape the
 * production HTTP client maps from gitea-mcp's wire response,
 * just without the network).
 */
import { describe, expect, it } from "vitest";

import {
  InMemoryMcpToolClient,
  McpResourceNotFoundError,
} from "../../src/mcp-tool-client/index.js";

describe("InMemoryMcpToolClient — basic resource reads", () => {
  it("returns the stored body for a known resource URI", async () => {
    const client = new InMemoryMcpToolClient();
    client.setResource("wiki://exec/index.md", "# index");
    const body = await client.readResource("wiki://exec/index.md");
    expect(body).toBe("# index");
  });

  it("throws McpResourceNotFoundError for an unknown URI", async () => {
    const client = new InMemoryMcpToolClient();
    await expect(
      client.readResource("wiki://exec/missing.md"),
    ).rejects.toBeInstanceOf(McpResourceNotFoundError);
  });

  it("McpResourceNotFoundError is errorClass='validation'", async () => {
    const client = new InMemoryMcpToolClient();
    try {
      await client.readResource("wiki://exec/missing.md");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { errorClass?: string }).errorClass).toBe("validation");
    }
  });
});

describe("InMemoryMcpToolClient — listResources", () => {
  it("listResources({ scheme }) returns the URIs whose scheme matches", async () => {
    const client = new InMemoryMcpToolClient();
    client.setResource("wiki://exec/index.md", "# i1");
    client.setResource("wiki://hr/index.md", "# i2");
    client.setResource("worldview://exec", "# w1");
    const wikis = await client.listResources({ scheme: "wiki" });
    expect([...wikis].sort()).toEqual([
      "wiki://exec/index.md",
      "wiki://hr/index.md",
    ]);
    const worldviews = await client.listResources({ scheme: "worldview" });
    expect([...worldviews]).toEqual(["worldview://exec"]);
  });

  it("listResources({ uriPrefix }) filters by prefix", async () => {
    const client = new InMemoryMcpToolClient();
    client.setResource("wiki://exec/index.md", "# i1");
    client.setResource("wiki://exec/team/eng.md", "# eng");
    client.setResource("wiki://hr/index.md", "# i2");
    const execOnly = await client.listResources({
      uriPrefix: "wiki://exec/",
    });
    expect([...execOnly].sort()).toEqual([
      "wiki://exec/index.md",
      "wiki://exec/team/eng.md",
    ]);
  });

  it("listResources without filters returns all stored URIs", async () => {
    const client = new InMemoryMcpToolClient();
    client.setResource("wiki://x/a.md", "a");
    client.setResource("worldview://x", "wv");
    const all = await client.listResources();
    expect([...all].sort()).toEqual([
      "wiki://x/a.md",
      "worldview://x",
    ]);
  });
});

describe("InMemoryMcpToolClient — port shape", () => {
  it("seedFromMap() bulk-loads a fixture in one call", async () => {
    const client = new InMemoryMcpToolClient();
    client.seedFromMap({
      "wiki://exec/index.md": "# index",
      "worldview://exec": "# worldview",
    });
    expect(await client.readResource("wiki://exec/index.md")).toBe("# index");
    expect(await client.readResource("worldview://exec")).toBe("# worldview");
  });

  it("reset() clears all stored resources", async () => {
    const client = new InMemoryMcpToolClient();
    client.setResource("wiki://x/a.md", "a");
    client.reset();
    await expect(client.readResource("wiki://x/a.md")).rejects.toBeInstanceOf(
      McpResourceNotFoundError,
    );
  });
});
