/**
 * Destructive-tool deny-list (THREAT-MODEL §3.8). The harness
 * runs every tool name through `isDenied` / `assertToolAllowed`
 * before dispatching the call; a match throws
 * AgentDenyListError (validation class).
 */
import { describe, expect, it } from "vitest";

import {
  AgentDenyListError,
  DENY_PREFIXES,
  EXACT_DENY_TOOLS,
  assertToolAllowed,
  isDenied,
} from "../../src/agent-harness/index.js";

describe("EXACT_DENY_TOOLS — exact-match deny set", () => {
  it("contains the v0.1 hardcoded list", () => {
    expect(EXACT_DENY_TOOLS).toContain("sql.execute_raw");
    expect(EXACT_DENY_TOOLS).toContain("sql.drop_table");
    expect(EXACT_DENY_TOOLS).toContain("wiki.delete_repo");
    expect(EXACT_DENY_TOOLS).toContain("wiki.force_push");
    expect(EXACT_DENY_TOOLS).toContain("fs.delete_recursive");
    expect(EXACT_DENY_TOOLS).toContain("shell.exec");
    expect(EXACT_DENY_TOOLS).toContain("process.kill_all");
    expect(EXACT_DENY_TOOLS).toContain("secrets.dump");
  });
});

describe("DENY_PREFIXES — namespace-prefix deny", () => {
  it("contains exactly two v0.1 prefixes", () => {
    expect(DENY_PREFIXES).toHaveLength(2);
    expect(DENY_PREFIXES).toContain("mcp.admin.");
    expect(DENY_PREFIXES).toContain("cli.deploy.");
  });
});

describe("isDenied", () => {
  it("returns true for an exact-match tool name", () => {
    expect(isDenied("sql.execute_raw")).toBe(true);
    expect(isDenied("shell.exec")).toBe(true);
  });

  it("returns true for a prefix-match tool name", () => {
    expect(isDenied("mcp.admin.list_workflows")).toBe(true);
    expect(isDenied("mcp.admin.delete_user")).toBe(true);
    expect(isDenied("cli.deploy.production")).toBe(true);
  });

  it("returns false for a non-denied tool", () => {
    expect(isDenied("sql.select")).toBe(false);
    expect(isDenied("wiki.read_page")).toBe(false);
    expect(isDenied("mcp.read.entry")).toBe(false);
    expect(isDenied("cli.status")).toBe(false);
  });

  it("returns false for an empty string (caller bug, but not denied)", () => {
    expect(isDenied("")).toBe(false);
  });

  it("does NOT match when the prefix is a substring elsewhere in the name", () => {
    // "embedded.mcp.admin.foo" doesn't START with "mcp.admin."
    // so the prefix check rejects it. The harness's deny-list
    // is anchored to the start of the tool name.
    expect(isDenied("embedded.mcp.admin.foo")).toBe(false);
  });
});

describe("assertToolAllowed", () => {
  it("returns silently for an allowed tool", () => {
    expect(() => assertToolAllowed("wiki.read_page")).not.toThrow();
  });

  it("throws AgentDenyListError for an exact-match deny", () => {
    expect(() => assertToolAllowed("sql.execute_raw")).toThrow(
      AgentDenyListError,
    );
  });

  it("throws AgentDenyListError for a prefix-match deny", () => {
    expect(() => assertToolAllowed("mcp.admin.shutdown")).toThrow(
      AgentDenyListError,
    );
  });

  it("AgentDenyListError carries the offending tool name + validation class", () => {
    try {
      assertToolAllowed("shell.exec");
      expect.fail("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentDenyListError);
      const e = err as AgentDenyListError;
      expect(e.toolName).toBe("shell.exec");
      expect(e.errorClass).toBe("validation");
    }
  });
});
