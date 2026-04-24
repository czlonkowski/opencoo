/**
 * Retrofit per Correction E from team-lead — runs the shared
 * `wikiAdapterContract` against `InMemoryWikiAdapter`. Proves the
 * contract is port-faithful in two backends, not just one (the
 * gitea-backed contract test lives in @opencoo/wiki-gitea).
 *
 * If a future change to InMemoryWikiAdapter drifts away from the port
 * shape, both this file AND every adapter using the same contract
 * fail simultaneously — drift is caught at the source, not at
 * downstream call sites.
 */
import { wikiAdapterContract } from "../src/adapter-contract-tests/wiki-adapter.js";
import { InMemoryWikiAdapter } from "../src/wiki-write/testing/in-memory-adapter.js";

wikiAdapterContract({
  backendName: "in-memory",
  async makeAdapter() {
    return {
      adapter: new InMemoryWikiAdapter(),
      cleanup: async () => undefined,
    };
  },
});
