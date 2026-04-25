/**
 * PAT-scoped MCP client wrapper (PR 20 part B / plan #97 Q4-Q5).
 *
 * `createPatScopedMcpClient(base, callerPat)` returns an
 * `McpToolClient` that delegates to `base` for resource I/O
 * but tags every call with the user's gitea PAT. In production
 * (PR 23+ HttpMcpToolClient), this wrapper is where the
 * `Authorization: Bearer <pat>` header gets injected; the
 * gitea-wiki-mcp-server then enforces the PAT's repo-scope on
 * every read. v0.1 ships only the wrapper shape — the
 * production header-injection lands when HttpMcpToolClient does.
 *
 * The InMemoryMcpToolClient stays pure-data (no PAT awareness).
 * The wrapper layer carries the PAT and is the single seam
 * Heartbeat/Lint do NOT cross (their callerPat is undefined,
 * so they never call createPatScopedMcpClient at all).
 */
import { describe, expect, it } from "vitest";

import {
  InMemoryMcpToolClient,
  createPatScopedMcpClient,
  type McpToolClient,
  type PatScopedAuditEntry,
} from "../../src/mcp-tool-client/index.js";

describe("createPatScopedMcpClient — wrapper shape", () => {
  it("returns an object that satisfies the McpToolClient port", () => {
    const base = new InMemoryMcpToolClient();
    const wrapped: McpToolClient = createPatScopedMcpClient(
      base,
      "ghp_xxx",
    );
    expect(typeof wrapped.readResource).toBe("function");
    expect(typeof wrapped.listResources).toBe("function");
  });

  it("delegates readResource to the base client", async () => {
    const base = new InMemoryMcpToolClient();
    base.setResource("wiki://exec/index.md", "# index");
    const wrapped = createPatScopedMcpClient(base, "ghp_xxx");
    const body = await wrapped.readResource("wiki://exec/index.md");
    expect(body).toBe("# index");
  });

  it("delegates listResources to the base client", async () => {
    const base = new InMemoryMcpToolClient();
    base.setResource("wiki://exec/index.md", "# i");
    base.setResource("wiki://exec/team/eng.md", "# e");
    const wrapped = createPatScopedMcpClient(base, "ghp_xxx");
    const uris = await wrapped.listResources({ uriPrefix: "wiki://exec/" });
    expect([...uris].sort()).toEqual([
      "wiki://exec/index.md",
      "wiki://exec/team/eng.md",
    ]);
  });
});

describe("createPatScopedMcpClient — PAT carrying (test inspection)", () => {
  // The wrapper exposes the bound PAT so tests + the
  // production HttpMcpToolClient header-injection layer can
  // observe what was attached. The InMemoryMcpToolClient stays
  // PAT-agnostic — the wrapper is the only place the PAT lives.
  it("exposes the bound PAT via .callerPat", () => {
    const base = new InMemoryMcpToolClient();
    const wrapped = createPatScopedMcpClient(base, "ghp_secret");
    expect(wrapped.callerPat).toBe("ghp_secret");
  });

  it("two wrappers around the same base carry independent PATs (no shared state on the base)", () => {
    const base = new InMemoryMcpToolClient();
    const aliceWrap = createPatScopedMcpClient(base, "ghp_alice");
    const bobWrap = createPatScopedMcpClient(base, "ghp_bob");
    expect(aliceWrap.callerPat).toBe("ghp_alice");
    expect(bobWrap.callerPat).toBe("ghp_bob");
    // The base remains a plain InMemoryMcpToolClient; nothing
    // about it has changed (no PAT-scope map on it).
    expect((base as { callerPat?: string }).callerPat).toBeUndefined();
  });

  it("does not mutate the base's resource map (the base remains pure data)", async () => {
    const base = new InMemoryMcpToolClient();
    base.setResource("wiki://x/a.md", "a");
    createPatScopedMcpClient(base, "ghp_xxx");
    // Wrapping does not strip / inject / decorate the base.
    expect(await base.readResource("wiki://x/a.md")).toBe("a");
  });
});

describe("createPatScopedMcpClient — observable PAT propagation per call", () => {
  // Tests need to assert "every call carries the PAT". The
  // wrapper records each call as a (uri, pat) tuple in an
  // optional `auditLog` so tests can verify; production
  // HttpMcpToolClient ignores the audit log and uses
  // `wrapper.callerPat` to inject the Authorization header.
  it("audit-log records each readResource call with the PAT", async () => {
    const base = new InMemoryMcpToolClient();
    base.setResource("wiki://x/a.md", "a");
    base.setResource("wiki://x/b.md", "b");
    const wrapped = createPatScopedMcpClient(base, "ghp_alice");
    await wrapped.readResource("wiki://x/a.md");
    await wrapped.readResource("wiki://x/b.md");
    expect(wrapped.auditLog).toEqual([
      { kind: "readResource", uri: "wiki://x/a.md", callerPat: "ghp_alice" },
      { kind: "readResource", uri: "wiki://x/b.md", callerPat: "ghp_alice" },
    ]);
  });

  it("audit-log records each listResources call with the PAT", async () => {
    const base = new InMemoryMcpToolClient();
    base.setResource("wiki://x/a.md", "a");
    const wrapped = createPatScopedMcpClient(base, "ghp_alice");
    await wrapped.listResources({ scheme: "wiki" });
    expect(wrapped.auditLog).toEqual([
      { kind: "listResources", filter: { scheme: "wiki" }, callerPat: "ghp_alice" },
    ]);
  });

  // Copilot #23 fix 1: the auditLog getter must return a
  // shallow copy so callers can't mutate the wrapper's
  // internal backing array via `as unknown as` escape hatches.
  it("auditLog getter returns a shallow copy — external mutation does not affect the wrapper's internal state", async () => {
    const base = new InMemoryMcpToolClient();
    base.setResource("wiki://x/a.md", "a");
    const wrapped = createPatScopedMcpClient(base, "ghp_alice");
    await wrapped.readResource("wiki://x/a.md");

    // Cast away readonly + push a fake entry.
    const escaped = wrapped.auditLog as unknown as PatScopedAuditEntry[];
    escaped.push({
      kind: "readResource",
      uri: "wiki://injected/poison.md",
      callerPat: "ghp_attacker",
    });

    // The wrapper's REAL audit log is untouched.
    expect(wrapped.auditLog).toEqual([
      { kind: "readResource", uri: "wiki://x/a.md", callerPat: "ghp_alice" },
    ]);
  });
});
