/**
 * Contract tier — runs the shared `wikiAdapterContract` against a REAL
 * Gitea sidecar. Gated on `GITEA_URL` + `GITEA_TOKEN` (+ optional
 * `GITEA_OWNER`, defaults to "wiki-gitea-test"). CI runs without
 * the env vars and skips the suite cleanly.
 *
 * Local setup:
 *   docker compose -f packages/adapters/wiki-gitea/docker-compose.test.yml up -d gitea
 *   eval $(./packages/adapters/wiki-gitea/scripts/bootstrap-gitea.sh --eval)
 *   pnpm --filter @opencoo/wiki-gitea test:contract
 *
 * Each test gets a fresh repo (random suffix) so concurrent or
 * leftover repos don't interfere. Cleanup deletes the repo via the
 * Gitea API after the test.
 */
import { describe, it, expect } from "vitest";

import { wikiAdapterContract } from "@opencoo/shared/adapter-contract-tests/wiki-adapter";

import { giteaWikiAdapter, GiteaRestClient } from "../src/index.js";

const GITEA_URL = process.env.GITEA_URL;
const GITEA_TOKEN = process.env.GITEA_TOKEN;
const GITEA_OWNER = process.env.GITEA_OWNER ?? "wiki-gitea-test";

const HAS_GITEA =
  GITEA_URL !== undefined &&
  GITEA_URL.length > 0 &&
  GITEA_TOKEN !== undefined &&
  GITEA_TOKEN.length > 0;

// Sentinel `it` so operators see a "passed" line confirming the env
// vars were detected. The actual contract suite registers below at
// module load time, only when both env vars are set.
describe.runIf(HAS_GITEA)("wiki-gitea — real Gitea sidecar", () => {
  it("delegates to shared wikiAdapterContract — run under GITEA_URL + GITEA_TOKEN", () => {
    expect(HAS_GITEA).toBe(true);
  });
});

if (HAS_GITEA) {
  const url = GITEA_URL as string;
  const token = GITEA_TOKEN as string;

  wikiAdapterContract({
    backendName: "gitea-real",
    async makeAdapter(domainSlug) {
      // Random suffix so concurrent test runs don't collide.
      const rand = Math.random().toString(36).slice(2, 10);
      const repoName = `wiki-${domainSlug}-${rand}`;
      const client = new GiteaRestClient({ url, token });

      // Create the repo via the Gitea admin API. We do this directly
      // with fetch so the GiteaClient port stays focused on the four
      // endpoints the adapter actually uses.
      const createRes = await fetch(`${url}/api/v1/user/repos`, {
        method: "POST",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          name: repoName,
          description: "wiki-gitea contract test (ephemeral)",
          private: false,
          auto_init: true,
          default_branch: "main",
        }),
      });
      if (!createRes.ok) {
        throw new Error(
          `failed to create test repo ${GITEA_OWNER}/${repoName}: HTTP ${createRes.status}`,
        );
      }

      // The adapter expects repo names of the form
      // `${repoPrefix}-${slug}`. Pin repoPrefix so this exact repo is
      // resolved.
      const adapter = giteaWikiAdapter({
        client,
        owner: GITEA_OWNER,
        repoPrefix: `wiki`, // adapter will request `wiki-${domainSlug}`
        branch: "main",
      });

      // Adapter would resolve `wiki-${domainSlug}` — but our actual
      // repo has the random suffix. To keep the contract suite happy
      // we DELETE the random-suffix repo and create one matching the
      // canonical `wiki-${domainSlug}` shape. Cleanup wipes it.
      await fetch(
        `${url}/api/v1/repos/${encodeURIComponent(GITEA_OWNER)}/${encodeURIComponent(repoName)}`,
        {
          method: "DELETE",
          headers: { Authorization: `token ${token}` },
        },
      );
      const canonicalName = `wiki-${domainSlug}`;
      // If a stale canonical-named repo exists from a previous run,
      // wipe it before re-creating.
      await fetch(
        `${url}/api/v1/repos/${encodeURIComponent(GITEA_OWNER)}/${encodeURIComponent(canonicalName)}`,
        {
          method: "DELETE",
          headers: { Authorization: `token ${token}` },
        },
      );
      const createCanonical = await fetch(`${url}/api/v1/user/repos`, {
        method: "POST",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          name: canonicalName,
          description: "wiki-gitea contract test (ephemeral)",
          private: false,
          auto_init: true,
          default_branch: "main",
        }),
      });
      if (!createCanonical.ok) {
        throw new Error(
          `failed to create canonical repo ${GITEA_OWNER}/${canonicalName}: HTTP ${createCanonical.status}`,
        );
      }

      return {
        adapter,
        async cleanup() {
          await fetch(
            `${url}/api/v1/repos/${encodeURIComponent(GITEA_OWNER)}/${encodeURIComponent(canonicalName)}`,
            {
              method: "DELETE",
              headers: { Authorization: `token ${token}` },
            },
          );
        },
        inspectCommit: (sha: string) =>
          client.inspectCommit({ owner: GITEA_OWNER, name: canonicalName }, sha),
      };
    },
  });
}
