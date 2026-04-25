/**
 * Agent tool wrappers — thin adapters from the
 * `wiki.read_page` / `worldview.read` / `index.search` tool
 * names the agents emit to the underlying McpToolClient port.
 *
 * Each wrapper is pure plumbing: take args → translate to a
 * McpToolClient call → return string body. They exist so that
 * the agent body can `ctx.callTool('wiki.read_page', () =>
 * wikiReadPage(client, {...}))` and have the deny-list +
 * tool-call ledger fire exactly once per call site.
 *
 * Tests pin:
 *   - URI shape mapping (domainSlug + path → wiki:// URI)
 *   - Pass-through error semantics (McpResourceNotFoundError
 *     bubbles unchanged)
 *   - Index search returns only paths matching the prefix
 *     (no full-text search in v0.1 — listResources is enough)
 */
import { describe, expect, it } from "vitest";

import { InMemoryMcpToolClient } from "../../src/mcp-tool-client/index.js";
import {
  indexSearch,
  wikiReadPage,
  worldviewRead,
} from "../../src/agents/tools/index.js";

describe("wikiReadPage — wiki.read_page tool wrapper", () => {
  it("translates (domainSlug, path) → wiki://{slug}/{path} and returns the body", async () => {
    const client = new InMemoryMcpToolClient();
    client.setResource("wiki://exec/team/eng.md", "# eng team");
    const body = await wikiReadPage(client, {
      domainSlug: "exec",
      path: "team/eng.md",
    });
    expect(body).toBe("# eng team");
  });

  it("propagates McpResourceNotFoundError unchanged for unknown pages", async () => {
    const client = new InMemoryMcpToolClient();
    await expect(
      wikiReadPage(client, { domainSlug: "exec", path: "missing.md" }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("worldviewRead — worldview.read tool wrapper", () => {
  it("translates (domainSlug) → worldview://{slug} and returns the body", async () => {
    const client = new InMemoryMcpToolClient();
    client.setResource("worldview://exec", "# exec worldview");
    const body = await worldviewRead(client, { domainSlug: "exec" });
    expect(body).toBe("# exec worldview");
  });

  it("supports the reserved 'company' aggregator slug", async () => {
    const client = new InMemoryMcpToolClient();
    client.setResource("worldview://company", "# company");
    const body = await worldviewRead(client, { domainSlug: "company" });
    expect(body).toBe("# company");
  });

  it("propagates McpResourceNotFoundError unchanged for un-compiled worldviews", async () => {
    const client = new InMemoryMcpToolClient();
    await expect(
      worldviewRead(client, { domainSlug: "missing" }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("indexSearch — index.search tool wrapper", () => {
  it("returns the wiki paths under a domain (sorted, .md only)", async () => {
    const client = new InMemoryMcpToolClient();
    client.setResource("wiki://exec/index.md", "# i");
    client.setResource("wiki://exec/team/eng.md", "# e");
    client.setResource("wiki://exec/team/sales.md", "# s");
    client.setResource("wiki://hr/index.md", "# i2");
    const paths = await indexSearch(client, { domainSlug: "exec" });
    expect(paths).toEqual([
      "index.md",
      "team/eng.md",
      "team/sales.md",
    ]);
  });

  it("supports a path prefix filter inside a domain", async () => {
    const client = new InMemoryMcpToolClient();
    client.setResource("wiki://exec/index.md", "# i");
    client.setResource("wiki://exec/team/eng.md", "# e");
    client.setResource("wiki://exec/team/sales.md", "# s");
    client.setResource("wiki://exec/quarterly/q1.md", "# q1");
    const paths = await indexSearch(client, {
      domainSlug: "exec",
      pathPrefix: "team/",
    });
    expect(paths).toEqual(["team/eng.md", "team/sales.md"]);
  });

  it("returns [] for a domain with no pages", async () => {
    const client = new InMemoryMcpToolClient();
    const paths = await indexSearch(client, { domainSlug: "exec" });
    expect(paths).toEqual([]);
  });

  it("does not leak pages from a different domain", async () => {
    const client = new InMemoryMcpToolClient();
    client.setResource("wiki://exec/secret.md", "# s");
    client.setResource("wiki://hr/index.md", "# h");
    const paths = await indexSearch(client, { domainSlug: "hr" });
    expect(paths).toEqual(["index.md"]);
  });
});
