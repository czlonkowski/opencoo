/**
 * Use-case tier — runs the shared `wikiAdapterContract` against
 * a `MockGiteaClient` (in-memory backend that mimics Gitea's REST
 * surface). Hermetic, fast, no Docker.
 *
 * The companion `wiki-gitea.contract.test.ts` runs the same suite
 * against a real Gitea sidecar and is gated on `GITEA_URL`.
 */
import { describe, it, expect } from "vitest";

import { wikiAdapterContract } from "@opencoo/shared/adapter-contract-tests/wiki-adapter";

import { giteaWikiAdapter } from "../src/index.js";
import { MockGiteaClient } from "../src/testing/mock-client.js";

wikiAdapterContract({
  backendName: "gitea-mock",
  async makeAdapter(domainSlug) {
    const client = new MockGiteaClient();
    // Each test uses a fresh repo; the adapter binds a domain slug to
    // a `${owner}/${repoPrefix}-${domainSlug}` Gitea repo. The mock
    // initialises that repo as empty so getHeadSha returns a stable
    // initial sha.
    const repo = { owner: "opencoo", name: `wiki-${domainSlug}` };
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
});
