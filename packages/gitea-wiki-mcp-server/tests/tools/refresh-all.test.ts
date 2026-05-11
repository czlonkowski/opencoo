/**
 * `POST /refresh-all` — opencoo-driven REPOS replace (phase-a appendix
 * #12 PR-Z8, closes G10).
 *
 * The endpoint replaces the in-memory `RepoRegistry` wholesale and
 * fires off best-effort cloning for any new repos. It is bearer-gated
 * (static token only — OAuth principals are forbidden) and never
 * touches disk during validation, so the assertions below run against
 * an in-memory stub `GitSync`.
 *
 * Pin matrix:
 *   1. 200 happy: validated body → registry mutated, ensureAllCloned called
 *   2. 401 without bearer
 *   3. 403 with wrong static-token bytes
 *   4. 400 on missing/invalid body
 *   5. 400 on validation failure (reserved slug, duplicate)
 *   6. Auto-promotes first entry to default when none flagged
 *   7. Existing /refresh/:slug still works (additive — does NOT
 *      regress the existing route surface)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startHttpServer, type HttpServerHandle } from "../../src/http/server.js";
import { createServer } from "../../src/server.js";
import type { Config } from "../../src/config.js";
import type { GitSync } from "../../src/sync/git-sync.js";

const STATIC_BEARER = "static-token-0123456789abcdef-long-enough";

interface StubSync {
  ensureAllClonedCalls: number;
  gitSync: GitSync;
}

function stubGitSync(): StubSync {
  const state = { ensureAllClonedCalls: 0 };
  const gitSync = {
    async pullOne() {
      return { changed: false };
    },
    async rebuildIndex() {
      return undefined;
    },
    async ensureAllCloned() {
      state.ensureAllClonedCalls += 1;
      return undefined;
    },
    startScheduler() {
      return undefined;
    },
    stopScheduler() {
      return undefined;
    },
  } as unknown as GitSync;
  return {
    get ensureAllClonedCalls(): number {
      return state.ensureAllClonedCalls;
    },
    gitSync,
  };
}

function makeConfig(dataDir: string): Config {
  return {
    mcpMode: "http",
    port: 0,
    host: "127.0.0.1",
    bearerToken: STATIC_BEARER,
    giteaPat: "pat",
    giteaBaseUrl: "http://gitea.local",
    repos: [
      {
        slug: "exec",
        owner: "opencoo",
        name: "wiki-exec",
        default: true,
        aggregator: false,
      },
    ],
    dataDir,
    syncIntervalMin: 0,
    // GITEA_WEBHOOK_SECRET is required for /refresh/:slug to NOT
    // 403; we set it so the regression test (item 7) exercises a
    // realistic path.
    giteaWebhookSecret: "test-webhook-secret",
    logLevel: "info",
    corsOrigins: "",
  };
}

interface BootedServer {
  readonly url: string;
  readonly handle: HttpServerHandle;
  readonly tmpRoot: string;
  readonly sync: StubSync;
  readonly registry: ReturnType<typeof createServer>["registry"];
}

async function boot(): Promise<BootedServer> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-all-"));
  const execRoot = path.join(tmpRoot, "repos", "exec");
  fs.mkdirSync(execRoot, { recursive: true });
  fs.writeFileSync(path.join(execRoot, "index.md"), "# Index\n");
  // Mark this directory as a git repo with an empty .git so the
  // /refresh/:slug regression test below doesn't blow up before
  // it hits the webhook-signature path. We don't actually pull;
  // the stub gitSync intercepts pullOne.
  fs.mkdirSync(path.join(execRoot, ".git"), { recursive: true });

  const config = makeConfig(tmpRoot);
  const { createMcpServer, registry } = createServer(config);
  const sync = stubGitSync();
  const handle = await startHttpServer(config, createMcpServer, registry, sync.gitSync);
  const url = `http://${handle.address.address}:${handle.address.port}`;
  return { url, handle, tmpRoot, sync, registry };
}

describe("POST /refresh-all (phase-a appendix #12 PR-Z8, G10)", () => {
  let booted: BootedServer;

  beforeAll(async () => {
    booted = await boot();
  });

  afterAll(async () => {
    await booted.handle.close();
    fs.rmSync(booted.tmpRoot, { recursive: true, force: true });
  });

  it("200 happy: replaces registry + triggers ensureAllCloned", async () => {
    const beforeCalls = booted.sync.ensureAllClonedCalls;
    const res = await fetch(`${booted.url}/refresh-all`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STATIC_BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repos: [
          { slug: "exec", owner: "opencoo", name: "wiki-exec", default: true },
          { slug: "hr", owner: "opencoo", name: "wiki-hr" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.repos).toEqual(["exec", "hr"]);

    // Registry mutated.
    const slugs = booted.registry.list().map((r) => r.slug).sort();
    expect(slugs).toEqual(["exec", "hr"]);

    // ensureAllCloned scheduled (microtask — give it a tick to fire).
    await new Promise((r) => setTimeout(r, 0));
    expect(booted.sync.ensureAllClonedCalls).toBeGreaterThan(beforeCalls);
  });

  it("auto-promotes first repo to default when caller omits the flag", async () => {
    const res = await fetch(`${booted.url}/refresh-all`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STATIC_BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repos: [
          { slug: "exec", owner: "opencoo" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(booted.registry.getDefaultSlug()).toBe("exec");
  });

  it("name defaults to slug when omitted", async () => {
    const res = await fetch(`${booted.url}/refresh-all`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STATIC_BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repos: [{ slug: "exec", owner: "opencoo", default: true }],
      }),
    });
    expect(res.status).toBe(200);
    const entries = booted.registry.list();
    expect(entries[0]?.name).toBe("exec");
  });

  it("401 without bearer", async () => {
    const res = await fetch(`${booted.url}/refresh-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repos: [{ slug: "exec", owner: "opencoo" }] }),
    });
    expect(res.status).toBe(401);
  });

  it("401 with wrong static-token bytes", async () => {
    const res = await fetch(`${booted.url}/refresh-all`, {
      method: "POST",
      headers: {
        Authorization: "Bearer not-the-right-token-but-long-enough-bytes",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repos: [{ slug: "exec", owner: "opencoo" }] }),
    });
    expect(res.status).toBe(401);
  });

  it("400 on missing repos array", async () => {
    const res = await fetch(`${booted.url}/refresh-all`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STATIC_BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_body");
  });

  it("400 on reserved slug 'company'", async () => {
    const res = await fetch(`${booted.url}/refresh-all`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STATIC_BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repos: [{ slug: "company", owner: "opencoo", default: true }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    expect(body.message).toMatch(/reserved/i);
  });

  it("400 on duplicate slug", async () => {
    const res = await fetch(`${booted.url}/refresh-all`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STATIC_BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repos: [
          { slug: "exec", owner: "opencoo", default: true },
          { slug: "exec", owner: "opencoo" },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("400 on too many aggregators", async () => {
    const res = await fetch(`${booted.url}/refresh-all`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STATIC_BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repos: [
          { slug: "exec", owner: "opencoo", default: true, aggregator: true },
          { slug: "hr", owner: "opencoo", aggregator: true },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    expect(body.message).toMatch(/aggregator/i);
  });

  it("existing /refresh/:slug remains routable (regression — does not 404)", async () => {
    // Without a valid signature this returns 401, not 404. That's
    // enough to prove the route still resolves — the per-request raw
    // body capture + the `/refresh/` path guard are unaffected by
    // adding `/refresh-all`.
    const res = await fetch(`${booted.url}/refresh/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("config readWithFile (G9 — _FILE Docker-secrets precedence)", () => {
  it("reads from <NAME>_FILE when set, stripping trailing newline", async () => {
    const mod = await import("../../src/config.js");
    const tmpFile = path.join(os.tmpdir(), `refresh-all-secret-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "super-secret-bearer-token\n");
    try {
      const env: Record<string, string | undefined> = {
        MCP_BEARER_TOKEN_FILE: tmpFile,
      };
      const v = mod.readWithFile(env, "MCP_BEARER_TOKEN");
      expect(v).toBe("super-secret-bearer-token");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("_FILE WINS over inline <NAME> when both set", async () => {
    const mod = await import("../../src/config.js");
    const tmpFile = path.join(os.tmpdir(), `refresh-all-secret-both-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "from-file\n");
    try {
      const env: Record<string, string | undefined> = {
        MCP_BEARER_TOKEN_FILE: tmpFile,
        MCP_BEARER_TOKEN: "from-inline",
      };
      const v = mod.readWithFile(env, "MCP_BEARER_TOKEN");
      expect(v).toBe("from-file");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("falls through to inline <NAME> when <NAME>_FILE is unset", async () => {
    const mod = await import("../../src/config.js");
    const env: Record<string, string | undefined> = {
      MCP_BEARER_TOKEN: "from-inline",
    };
    const v = mod.readWithFile(env, "MCP_BEARER_TOKEN");
    expect(v).toBe("from-inline");
  });

  it("returns undefined when neither <NAME>_FILE nor <NAME> is set", async () => {
    const mod = await import("../../src/config.js");
    const env: Record<string, string | undefined> = {};
    const v = mod.readWithFile(env, "MCP_BEARER_TOKEN");
    expect(v).toBeUndefined();
  });

  it("treats empty _FILE path as unset (falls through to inline)", async () => {
    const mod = await import("../../src/config.js");
    const env: Record<string, string | undefined> = {
      MCP_BEARER_TOKEN_FILE: "",
      MCP_BEARER_TOKEN: "from-inline",
    };
    const v = mod.readWithFile(env, "MCP_BEARER_TOKEN");
    expect(v).toBe("from-inline");
  });

  it("throws when <NAME>_FILE path doesn't exist", async () => {
    const mod = await import("../../src/config.js");
    const env: Record<string, string | undefined> = {
      MCP_BEARER_TOKEN_FILE: "/nonexistent/path/secret.txt",
    };
    expect(() => mod.readWithFile(env, "MCP_BEARER_TOKEN")).toThrow();
  });
});
