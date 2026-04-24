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
 * Repo isolation (copilot #13 fix 4): every test gets its OWN
 * `repoPrefix` of the form `wiki-test-${random}` so the adapter
 * resolves to a fully-randomised repo name (`wiki-test-${rand}-${slug}`)
 * that cannot collide with a canonical `wiki-${slug}` repo. The test
 * never deletes or mutates a canonical name — even if `GITEA_URL`
 * accidentally pointed at a non-ephemeral Gitea, real wikis would be
 * untouched. Concurrent test runs also don't collide because each
 * run picks its own random prefix.
 *
 * Teardown deletes the just-created repo via DELETE
 * `/api/v1/repos/{owner}/{name}`. On teardown failure we WARN to the
 * console but do not fail the suite (avoids leaking repos blocking
 * the CI signal on a transient API hiccup).
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
      // Random per-test prefix so the adapter resolves to a unique
      // repo name (`wiki-test-${rand}-${slug}`). NEVER touches a
      // canonical `wiki-${slug}` repo — fail-safe against a
      // misconfigured GITEA_URL pointing at a real Gitea.
      const rand = Math.random().toString(36).slice(2, 10);
      const repoPrefix = `wiki-test-${rand}`;
      const repoName = `${repoPrefix}-${domainSlug}`;

      // Create the per-test repo via the Gitea admin API. We do this
      // directly with fetch so the GiteaClient port stays focused on
      // the four endpoints the adapter actually uses.
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

      const client = new GiteaRestClient({ url, token });
      const adapter = giteaWikiAdapter({
        client,
        owner: GITEA_OWNER,
        repoPrefix, // randomised — adapter resolves to repoName above
        branch: "main",
      });

      return {
        adapter,
        async cleanup() {
          // Best-effort delete; teardown failure WARNS but doesn't
          // fail the suite (transient API hiccups shouldn't drown
          // out a real assertion failure). Leaked repos surface
          // on the next test run if the rand prefix collides
          // (probabilistically: 36^8 namespace, ignorable).
          const del = await fetch(
            `${url}/api/v1/repos/${encodeURIComponent(GITEA_OWNER)}/${encodeURIComponent(repoName)}`,
            {
              method: "DELETE",
              headers: { Authorization: `token ${token}` },
            },
          );
          if (!del.ok && del.status !== 404) {
            console.warn(
              `[wiki-gitea contract] teardown failed for ${GITEA_OWNER}/${repoName}: HTTP ${del.status} (test still passed; repo may need manual cleanup)`,
            );
          }
        },
        inspectCommit: (sha: string) =>
          client.inspectCommit({ owner: GITEA_OWNER, name: repoName }, sha),
      };
    },
  });
}
