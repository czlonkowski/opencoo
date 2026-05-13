/**
 * Use-case tier — runs the shared `wikiAdapterContract` against
 * a `MockGiteaClient` (in-memory backend that mimics Gitea's REST
 * surface). Hermetic, fast, no Docker.
 *
 * The companion `wiki-gitea.contract.test.ts` runs the same suite
 * against a real Gitea sidecar and is gated on `GITEA_URL`.
 */
import { describe, it, expect, vi } from "vitest";

import { wikiAdapterContract } from "@opencoo/shared/adapter-contract-tests/wiki-adapter";

import { giteaWikiAdapter, GiteaRestClient } from "../src/index.js";
import { MockGiteaClient } from "../src/testing/mock-client.js";

wikiAdapterContract({
  backendName: "gitea-mock",
  async makeAdapter(domainSlug) {
    const client = new MockGiteaClient();
    // Each test uses a fresh repo; the adapter binds a domain slug to
    // a `${owner}/${repoPrefix}-${domainSlug}` Gitea repo (or just
    // `${owner}/${domainSlug}` if the slug already carries the prefix
    // — PR-Y3 backward-compat for partner-legacy deployments that
    // chose pre-prefixed slugs). The mock initialises that repo as
    // empty so getHeadSha returns a stable initial sha.
    const slug = String(domainSlug);
    const name = slug.startsWith("wiki-") ? slug : `wiki-${slug}`;
    const repo = { owner: "opencoo", name };
    await client.initRepo(repo);
    const adapter = giteaWikiAdapter({
      client,
      owner: "opencoo",
      repoPrefix: "wiki",
      branch: "main",
    });
    return {
      adapter,
      cleanup: async () => undefined,
      // CommitInspector — the mock records every commit so the
      // pass-through assertions (8/9/10) can introspect them. The
      // contract's CommitInspector is repo-blind (sha is enough);
      // we close over the repo here.
      inspectCommit: (sha: string) => client.inspectCommit(repo, sha),
    };
  },
});

// Backend-specific guards — repo-binding behaviour the contract suite
// can't express without leaking Gitea-shape into the port.
describe("wiki-gitea — package-local", () => {
  it("binds domainSlug to {owner}/{repoPrefix}-{slug} and never crosses domains", async () => {
    const client = new MockGiteaClient();
    await client.initRepo({ owner: "opencoo", name: "wiki-exec" });
    await client.initRepo({ owner: "opencoo", name: "wiki-hr" });

    const adapter = giteaWikiAdapter({
      client,
      owner: "opencoo",
      repoPrefix: "wiki",
      branch: "main",
    });

    const execSlug = "exec" as Parameters<typeof adapter.getHeadSha>[0];
    const hrSlug = "hr" as Parameters<typeof adapter.getHeadSha>[0];

    const sha0 = await adapter.getHeadSha(execSlug);
    const r = await adapter.writeAtomic({
      domainSlug: execSlug,
      operations: [{ mode: "replace", path: "x.md", content: "x\n" }],
      commitMessage: "[compiler] x",
      author: { name: "engine", email: "e@e.test" },
      parentSha: sha0,
    });
    expect(r.status).toBe("ok");

    // hr repo must NOT see x.md
    const hrPage = await adapter.readPage(hrSlug, "x.md");
    expect(hrPage).toBeNull();
  });

  // PR-Y3 (phase-a follow-up) — legacy partner cutovers picked slugs
  // that already carried the `wiki-` prefix (`gitea-provisioning.ts`
  // creates the Gitea repo as the BARE slug, so the operator put the
  // prefix in the slug). Without the strip-if-present rule, `repoFor`
  // would compute `wiki-wiki-estyl-pilot` and 404 on every read. This
  // test pins both paths: a bare slug gets the prefix; a slug that
  // already carries the prefix passes through unchanged.
  it("resolves repo name correctly whether slug carries the prefix or not (PR-Y3)", async () => {
    const client = new MockGiteaClient();
    // Two repos, one created by the new convention, one by the
    // partner-legacy convention. Both should be readable.
    await client.initRepo({ owner: "opencoo", name: "wiki-exec" });
    await client.initRepo({ owner: "opencoo", name: "wiki-estyl-pilot" });

    const adapter = giteaWikiAdapter({
      client,
      owner: "opencoo",
      repoPrefix: "wiki",
      branch: "main",
    });

    type Slug = Parameters<typeof adapter.getHeadSha>[0];
    // Case A — bare slug; adapter prepends prefix.
    const aSha = await adapter.getHeadSha("exec" as Slug);
    expect(aSha).toBeDefined();
    // Case B — slug already carries the prefix; adapter passes through.
    const bSha = await adapter.getHeadSha("wiki-estyl-pilot" as Slug);
    expect(bSha).toBeDefined();

    // Write under both shapes; the underlying repos are isolated, so
    // a write under the bare slug must NOT bleed into the prefix-slug
    // repo and vice versa.
    const aR = await adapter.writeAtomic({
      domainSlug: "exec" as Slug,
      operations: [{ mode: "replace", path: "a.md", content: "A\n" }],
      commitMessage: "[compiler] a",
      author: { name: "engine", email: "e@e.test" },
      parentSha: aSha,
    });
    expect(aR.status).toBe("ok");
    const bR = await adapter.writeAtomic({
      domainSlug: "wiki-estyl-pilot" as Slug,
      operations: [{ mode: "replace", path: "b.md", content: "B\n" }],
      commitMessage: "[compiler] b",
      author: { name: "engine", email: "e@e.test" },
      parentSha: bSha,
    });
    expect(bR.status).toBe("ok");

    const aRead = await adapter.readPage("exec" as Slug, "a.md");
    expect(aRead?.content).toBe("A\n");
    const bRead = await adapter.readPage("wiki-estyl-pilot" as Slug, "b.md");
    expect(bRead?.content).toBe("B\n");
    // Cross-check: neither file leaks into the other repo.
    expect(await adapter.readPage("exec" as Slug, "b.md")).toBeNull();
    expect(
      await adapter.readPage("wiki-estyl-pilot" as Slug, "a.md"),
    ).toBeNull();
  });
});

// (copilot #13) — `commitFiles` MUST preflight the branch HEAD against
// `parentSha` before POSTing. Gitea's per-file SHA rejection only
// catches conflicts ON THE SAME PATH; an unrelated concurrent commit
// can advance HEAD without per-file conflict, and the naive impl
// (POST then trust 422-or-go) silently writes a commit whose git
// parent is the unrelated concurrent commit, NOT `parentSha`. That
// violates the WriteAtomicArgs.parentSha contract in
// @opencoo/shared/wiki-write/interface.ts.
describe("wiki-gitea — preflight parentSha (copilot #13 fix 3)", () => {
  it("MockGiteaClient.commitFiles surfaces stale when an unrelated concurrent commit advances HEAD", async () => {
    // Adapter-level regression-lock — proves the Mock's preflight
    // behaviour (HEAD vs parentSha check) is wired correctly. The
    // Mock has always honoured this by construction; this test pins
    // the contract so any future "optimisation" of the mock that
    // skips the head-check fails loudly.
    const client = new MockGiteaClient();
    const repo = { owner: "opencoo", name: "wiki-exec" };
    await client.initRepo(repo);
    const adapter = giteaWikiAdapter({
      client,
      owner: "opencoo",
      repoPrefix: "wiki",
      branch: "main",
    });
    const execSlug = "exec" as Parameters<typeof adapter.getHeadSha>[0];

    const oldHead = await adapter.getHeadSha(execSlug);
    // Simulate an external commit that advanced HEAD by writing an
    // UNRELATED file. The adapter's pending write targets `target.md`,
    // which is not what got modified.
    client._injectConcurrentCommit(repo, "main", "unrelated.md", "noise\n");

    const result = await adapter.writeAtomic({
      domainSlug: execSlug,
      operations: [{ mode: "replace", path: "target.md", content: "ours\n" }],
      commitMessage: "[compiler] target",
      author: { name: "engine", email: "e@e.test" },
      parentSha: oldHead,
    });

    expect(result.status).toBe("stale");
    if (result.status === "stale") {
      expect(result.currentSha).not.toBe(oldHead);
    }
    // target.md must NOT have been written.
    const stillNull = await adapter.readPage(execSlug, "target.md");
    expect(stillNull).toBeNull();
  });

  it("GiteaRestClient.commitFiles preflights HEAD vs parentSha and skips the POST when stale", async () => {
    // The actual bug surface — real client must detect HEAD drift
    // BEFORE issuing the write. Without a preflight `getBranchSha`,
    // a server that accepts the commit (because per-file SHAs match
    // — the conflicting commit was on a different path) silently
    // succeeds with the WRONG git parent.
    const branchHead = "advanced0000000000000000000000000000abcd";
    const stalePostShouldSucceed = vi.fn();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "GET" && url.includes("/branches/main")) {
        return new Response(
          JSON.stringify({ commit: { id: branchHead } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (init?.method === "POST" && url.endsWith("/contents")) {
        // If the impl forgot to preflight, the commit POST reaches
        // here. The fake server "succeeds" — exactly the silent
        // failure mode (copilot #13) flagged.
        stalePostShouldSucceed();
        return new Response(
          JSON.stringify({ commit: { sha: "would-be-wrong-parent" } }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 599 });
    }) as unknown as typeof fetch;

    const client = new GiteaRestClient({
      url: "http://gitea.test",
      token: "tok",
      fetchImpl,
    });

    const result = await client.commitFiles({
      repo: { owner: "o", name: "r" },
      branch: "main",
      // Stale parentSha — does NOT match `branchHead`.
      parentSha: "stale00000000000000000000000000000000abcd",
      message: "[compiler] x",
      authorName: "engine",
      authorEmail: "e@e.test",
      files: [
        {
          mode: "create",
          path: "target.md",
          contentBase64: Buffer.from("ours\n", "utf8").toString("base64"),
        },
      ],
    });

    expect(result.status).toBe("stale");
    if (result.status === "stale") {
      expect(result.currentSha).toBe(branchHead);
    }
    // The would-have-been-silent-write POST MUST NOT have been issued.
    expect(stalePostShouldSucceed).not.toHaveBeenCalled();
  });
});
