import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { createWorldviewReader } from "../../src/resources/worldview.js";
import type { GiteaScopeChecker } from "../../src/services/scope-checker.js";
import { RepoRegistry } from "../../src/services/repo-registry.js";
import type { Config, RepoEntry } from "../../src/config.js";

// Minimal AuthInfo shape used in these tests. Matches what the bearer
// middleware sets on `req.auth` (subset of the MCP SDK's AuthInfo).
interface TestAuthInfo {
  readonly token: string;
  readonly clientId?: string;
  readonly scopes: readonly string[];
  readonly extra?: { readonly kind?: "static" | "gitea" };
}

/** Null scope checker that would fail loud if hit (tests that shouldn't
 *  invoke scope check — static-token path — use this). */
function spyOnlyScopeChecker(): GiteaScopeChecker & {
  readonly spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn();
  return {
    check: spy as unknown as GiteaScopeChecker["check"],
    invalidate: () => undefined,
    spy,
  };
}

function allowingScopeChecker(): GiteaScopeChecker {
  return {
    async check() {
      return { allow: true };
    },
    invalidate() {},
  };
}

function denyingScopeChecker(): GiteaScopeChecker {
  return {
    async check() {
      return { allow: false };
    },
    invalidate() {},
  };
}

function freshRegistry(entries: ReadonlyArray<RepoEntry>, dataDir: string): RepoRegistry {
  const config: Config = {
    mcpMode: "stdio",
    port: 3000,
    host: "127.0.0.1",
    bearerToken: "x".repeat(32),
    giteaPat: "pat",
    giteaBaseUrl: "http://gitea.local",
    repos: [...entries],
    dataDir,
    syncIntervalMin: 0,
    giteaWebhookSecret: "",
    logLevel: "info",
    corsOrigins: "",
  };
  return new RepoRegistry(config);
}

const STATIC_AUTH: TestAuthInfo = {
  token: "static-token",
  scopes: [],
  extra: { kind: "static" },
};
const OAUTH_AUTH: TestAuthInfo = {
  token: "oauth-token-abc",
  scopes: [],
  extra: { kind: "gitea" },
};

describe("worldview resource — setup + registry wiring", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worldview-test-"));
    // Lay out one domain repo with a worldview.md at its root.
    const execRoot = path.join(tmpRoot, "repos", "exec");
    fs.mkdirSync(execRoot, { recursive: true });
    fs.writeFileSync(
      path.join(execRoot, "worldview.md"),
      "# Exec Worldview\nSENTINEL-EXEC\n",
    );
    // Second repo WITHOUT a worldview.md (to exercise the missing-file
    // branch).
    const hrRoot = path.join(tmpRoot, "repos", "hr");
    fs.mkdirSync(hrRoot, { recursive: true });
    // Aggregator repo with BOTH worldview.md AND company.md at root.
    const aggRoot = path.join(tmpRoot, "repos", "roll-up");
    fs.mkdirSync(aggRoot, { recursive: true });
    fs.writeFileSync(
      path.join(aggRoot, "worldview.md"),
      "# Roll-up Worldview\nSENTINEL-ROLLUP-WV\n",
    );
    fs.writeFileSync(
      path.join(aggRoot, "company.md"),
      "# Company\nSENTINEL-ROLLUP-COMPANY\n",
    );
  });

  function baseEntries(): RepoEntry[] {
    return [
      {
        slug: "exec",
        owner: "opencoo",
        name: "wiki-exec",
        default: true,
        aggregator: false,
      },
      {
        slug: "hr",
        owner: "opencoo",
        name: "wiki-hr",
        default: false,
        aggregator: false,
      },
      {
        slug: "roll-up",
        owner: "opencoo",
        name: "wiki-roll-up",
        default: false,
        aggregator: true,
      },
    ];
  }

  it("returns worldview.md for an allowed slug (static principal, no scope check)", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const checker = spyOnlyScopeChecker();
    const reader = createWorldviewReader({ registry, scopeChecker: checker });
    const result = await reader(new URL("worldview://exec"), {
      authInfo: STATIC_AUTH,
    });
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content?.uri).toBe("worldview://exec");
    expect(content?.mimeType).toBe("text/markdown");
    expect(content?.text).toContain("SENTINEL-EXEC");
    // Static principal bypasses scope check.
    expect(checker.spy).not.toHaveBeenCalled();
  });

  it("returns company.md for worldview://company when an aggregator is configured", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWorldviewReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    const result = await reader(new URL("worldview://company"), {
      authInfo: STATIC_AUTH,
    });
    const content = result.contents[0];
    expect(content?.uri).toBe("worldview://company");
    expect(content?.text).toContain("SENTINEL-ROLLUP-COMPANY");
    // aggregator's OWN `worldview://{slug}` returns worldview.md, not company.md
    const result2 = await reader(new URL("worldview://roll-up"), {
      authInfo: STATIC_AUTH,
    });
    expect(result2.contents[0]?.text).toContain("SENTINEL-ROLLUP-WV");
  });

  it("denies worldview://company when no aggregator is configured", async () => {
    const noAgg: RepoEntry[] = [
      {
        slug: "exec",
        owner: "opencoo",
        name: "wiki-exec",
        default: true,
        aggregator: false,
      },
    ];
    const registry = freshRegistry(noAgg, tmpRoot);
    const reader = createWorldviewReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    await expect(
      reader(new URL("worldview://company"), { authInfo: STATIC_AUTH }),
    ).rejects.toThrow(McpError);
    try {
      await reader(new URL("worldview://company"), { authInfo: STATIC_AUTH });
    } catch (err) {
      expect((err as McpError).code).toBe(ErrorCode.InvalidRequest);
      expect((err as McpError).message).toMatch(/not accessible/i);
    }
  });

  it("denies worldview://{unknown-slug} uniformly (no-such-repo)", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWorldviewReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    await expect(
      reader(new URL("worldview://nope"), { authInfo: STATIC_AUTH }),
    ).rejects.toThrow(/not accessible/i);
  });

  it("denies when worldview.md is missing on disk (uniform message)", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWorldviewReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    // `hr` slug exists in registry but the fixture has no worldview.md.
    await expect(
      reader(new URL("worldview://hr"), { authInfo: STATIC_AUTH }),
    ).rejects.toThrow(/not accessible/i);
  });

  it("denies OAuth principal when scope check returns allow:false", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWorldviewReader({
      registry,
      scopeChecker: denyingScopeChecker(),
    });
    await expect(
      reader(new URL("worldview://exec"), { authInfo: OAUTH_AUTH }),
    ).rejects.toThrow(/not accessible/i);
  });

  it("allows OAuth principal when scope check returns allow:true", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWorldviewReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    const result = await reader(new URL("worldview://exec"), {
      authInfo: OAUTH_AUTH,
    });
    expect(result.contents[0]?.text).toContain("SENTINEL-EXEC");
  });

  it("passes the OAuth principal's token to the scope checker (cross-PAT no-leak)", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const calls: Array<{ token: string; owner: string; name: string }> = [];
    const checker: GiteaScopeChecker = {
      async check(token, owner, name) {
        calls.push({ token, owner, name });
        return { allow: token === "ok-token" };
      },
      invalidate() {},
    };
    const reader = createWorldviewReader({ registry, scopeChecker: checker });
    await expect(
      reader(new URL("worldview://exec"), {
        authInfo: { token: "bad-token", scopes: [], extra: { kind: "gitea" } },
      }),
    ).rejects.toThrow(/not accessible/i);
    const ok = await reader(new URL("worldview://exec"), {
      authInfo: { token: "ok-token", scopes: [], extra: { kind: "gitea" } },
    });
    expect(ok.contents[0]?.text).toContain("SENTINEL-EXEC");
    expect(calls).toEqual([
      { token: "bad-token", owner: "opencoo", name: "wiki-exec" },
      { token: "ok-token", owner: "opencoo", name: "wiki-exec" },
    ]);
  });

  it("denies when authInfo is missing (neither static nor OAuth principal)", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWorldviewReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    await expect(
      reader(new URL("worldview://exec"), {}),
    ).rejects.toThrow(/not accessible/i);
  });
});
