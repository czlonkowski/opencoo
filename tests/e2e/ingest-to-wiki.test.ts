/**
 * E2E #1 — ingest-to-wiki (PRD §5 criterion 2).
 *
 * Drives the Scanner → CompilationWorker chain in-band against
 * the compose-spun Postgres + Gitea + Redis. Three sub-tests
 * sharing one bring-up:
 *
 *   a) canonical — a Q4-plan doc the MockLlmClient is keyed to
 *      accept; asserts a wiki page lands in Gitea with the
 *      expected body, that intake.status flipped to
 *      `classified`, and that page_citations recorded the
 *      source_ref.
 *   b) cross-domain-write attacker — loaded from PR 31's
 *      `attackerOutput`. The MockLlmClient returns the
 *      fully-pwned classifier output; the orchestrator MUST
 *      reject via ClassifierValidationError so NO write reaches
 *      the attacker's `wiki-finance-secrets` repo (we assert
 *      404 against the Gitea API).
 *   c) path-traversal attacker — same shape; reject via
 *      ClassifierPathError; no write to `../../...` shaped
 *      paths.
 *
 * Why in-band rather than engine subprocess: the engines don't
 * yet expose a runnable bin entry, and adding one alongside
 * BullMQ worker bootstrap would balloon this PR well beyond
 * the planner-budgeted scope. The in-band call exercises the
 * exact same `runCompilationWorker` function path the
 * production composition root would invoke. See the final
 * report for the full deviation rationale.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConsoleLogger } from "../../packages/shared/src/logger.js";
import {
  LlmRouter,
  MockLlmClient,
} from "../../packages/shared/src/llm-router/index.js";
import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiWriteDeps,
} from "../../packages/shared/src/wiki-write/index.js";
import {
  giteaWikiAdapter,
  GiteaRestClient,
} from "../../packages/adapters/wiki-gitea/src/index.js";
import { runScanner } from "../../packages/engine-ingestion/src/pipelines/scanner.js";
import { runCompilationWorker } from "../../packages/engine-ingestion/src/pipelines/compilation-worker.js";
import {
  ClassifierPathError,
} from "../../packages/engine-ingestion/src/classifier/path-guard.js";
import {
  ClassifierValidationError,
} from "../../packages/engine-ingestion/src/classifier/errors.js";
import type { GuardAdapter } from "../../packages/shared/src/adapter-contract-tests/guard.js";
import type { ScannerClassifyJob } from "../../packages/engine-ingestion/src/pipelines/scanner.js";

import {
  dockerAvailable,
  startCompose,
  stopCompose,
} from "./_setup/compose-controller.js";
import {
  bootstrapEnvironment,
  disposeEnvironment,
  resetForTest,
  type E2EEnvironment,
} from "./_setup/seed.js";
import {
  CANONICAL_CLASSIFIER_OUTPUT,
  CANONICAL_COMPILER_OUTPUT,
  CANONICAL_DOC_BODY,
  loadCrossDomainWriteFixture,
  loadPathTraversalFixture,
} from "./_setup/fixtures.js";
import { createInMemorySource } from "./_setup/in-memory-source.js";

const HAS_DOCKER = dockerAvailable();

const DOMAIN_SLUG = "wiki-execs";
const GITEA_REPO = `wiki-${DOMAIN_SLUG}`;
const ALLOWED_PATHS = ["strategy/**", "executive/**"];

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function passThroughGuard(): GuardAdapter {
  return {
    slug: "e2e-passthrough",
    role: "redaction",
    categories: [],
    patternVersion: "v1-test",
    async classify(input) {
      return { events: [], transformedText: input.text };
    },
  };
}

interface SeededBinding {
  readonly bindingId: string;
  readonly domainId: string;
}

async function seedDomainAndBinding(
  env: E2EEnvironment,
): Promise<SeededBinding> {
  const domain = await env.pgPool.query<{ id: string }>(
    `INSERT INTO domains (slug, name, locale)
     VALUES ($1, 'Executives', 'en')
     RETURNING id`,
    [DOMAIN_SLUG],
  );
  const domainId = domain.rows[0]!.id;
  const binding = await env.pgPool.query<{ id: string }>(
    `INSERT INTO sources_bindings
       (domain_id, adapter_slug, source_id, allowed_paths, enabled)
     VALUES ($1::uuid, 'e2e-inmem', 'e2e-folder-1', $2::text[], true)
     RETURNING id`,
    [domainId, ALLOWED_PATHS],
  );
  return { bindingId: binding.rows[0]!.id, domainId };
}

interface InMemoryEnqueue {
  readonly jobs: ScannerClassifyJob[];
  add(name: string, data: ScannerClassifyJob): Promise<unknown>;
}

function makeEnqueue(): InMemoryEnqueue {
  const jobs: ScannerClassifyJob[] = [];
  return {
    jobs,
    async add(_name: string, data: ScannerClassifyJob): Promise<unknown> {
      jobs.push(data);
      return undefined;
    },
  };
}

function buildWikiDeps(env: E2EEnvironment): WikiWriteDeps {
  const client = new GiteaRestClient({
    url: env.giteaBaseUrl,
    token: env.giteaAdminPat,
  });
  const adapter = giteaWikiAdapter({
    client,
    owner: env.giteaAdminUser,
    // The Gitea adapter formats repos as `${repoPrefix}-${domainSlug}`,
    // so `repoPrefix: "wiki"` + `domainSlug: "execs"` resolves to
    // the `wiki-execs` repo `seedForTest` recreates.
    repoPrefix: "wiki",
    branch: "main",
  });
  return {
    adapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: new InMemoryDeleteCap(),
    logger: silentLogger(),
    clock: () => new Date("2026-04-25T12:00:00Z"),
    instanceId: "e2e",
  };
}

let env: E2EEnvironment | null = null;

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  await startCompose();
  env = await bootstrapEnvironment();
}, 300_000);

afterAll(async () => {
  await disposeEnvironment();
  await stopCompose();
}, 60_000);

describe.runIf(HAS_DOCKER)(
  "e2e — ingest-to-wiki (PRD §5 #2)",
  () => {
    it("canonical doc lands as a wiki page with frontmatter + page_citations row", async () => {
      const e = env!;
      await resetForTest(e, { wikiRepos: [GITEA_REPO] });
      const { bindingId, domainId } = await seedDomainAndBinding(e);

      // Mock LLM: classifier accepts canonical, compiler emits
      // canonical merged body.
      const mock = new MockLlmClient();
      mock.register({
        match: { model: "gpt-4o-mini", promptIncludes: "opencoo Classifier" },
        response: {
          text: JSON.stringify(CANONICAL_CLASSIFIER_OUTPUT),
          tokensIn: 100,
          tokensOut: 50,
        },
      });
      mock.register({
        match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
        response: {
          text: JSON.stringify(CANONICAL_COMPILER_OUTPUT),
          tokensIn: 100,
          tokensOut: 80,
        },
      });

      const router = new LlmRouter({
        db: e.db as unknown as Parameters<typeof LlmRouter>[0]["db"],
        env: {},
        logger: silentLogger(),
        pauser: {
          paused: () => false,
          pause: () => undefined,
          resume: () => undefined,
        },
        provider: mock,
      });

      // Drive the Scanner against an in-memory source with one
      // canonical doc.
      const source = createInMemorySource({
        documents: [
          {
            sourceDocId: "doc-q4-plan",
            sourceRevision: "rev-1",
            sourceRef: "drive:doc-q4-plan",
            contentBytes: Buffer.from(CANONICAL_DOC_BODY, "utf8"),
          },
        ],
      });
      const enqueue = makeEnqueue();
      const scanResult = await runScanner({
        db: e.db as unknown as Parameters<typeof runScanner>[0]["db"],
        logger: silentLogger(),
        adapterRegistry: {
          get: (slug) => (slug === "e2e-inmem" ? source : undefined),
        },
        enqueue,
      });
      expect(scanResult.bindingsScanned).toBe(1);
      expect(scanResult.documentsEnqueued).toBe(1);
      expect(enqueue.jobs).toHaveLength(1);

      // Drive the Compilation Worker against the enqueued job.
      const workerResult = await runCompilationWorker({
        db: e.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router,
        wikiDeps: buildWikiDeps(e),
        author: { name: "opencoo-e2e", email: "e2e@opencoo.test" },
        guardAdapter: passThroughGuard(),
        job: enqueue.jobs[0]!,
      });
      expect(workerResult.classifiedDomains).toBe(1);
      expect(workerResult.commitsLanded).toBe(1);

      // The wiki page MUST exist on Gitea with the expected body.
      const pageRes = await fetch(
        `${e.giteaBaseUrl}/api/v1/repos/${e.giteaAdminUser}/${GITEA_REPO}/contents/strategy/q4-plan.md`,
        {
          headers: { Authorization: `token ${e.giteaAdminPat}` },
        },
      );
      expect(pageRes.status).toBe(200);
      const pageJson = (await pageRes.json()) as { content: string };
      const decoded = Buffer.from(pageJson.content, "base64").toString("utf8");
      // Frontmatter compile-provenance per PRD §5 #2 + THREAT-MODEL
      // §3.4. The Compiler emits schema_version + prompt_version +
      // compiled_at on every page; `compiled_by_run_id` lives on
      // the matching `page_citations` row (Compiler doesn't run
      // inside an agent harness in v0.1, so the page's
      // frontmatter does not carry the run id — only the
      // citation row does, and that's the audit substrate).
      expect(decoded).toContain("schema_version:");
      expect(decoded).toContain("prompt_version:");
      expect(decoded).toContain("compiled_at:");
      // Body content survived the merge.
      expect(decoded).toContain("# Q4 strategy plan");
      expect(decoded).toContain("Headline priorities");

      // page_citations row must record the source_ref so a
      // future `opencoo source forget` can find it. Also pins
      // prompt_version on the citation, satisfying the audit
      // substrate side of the §5 #2 compile-provenance contract.
      const citation = await e.pgPool.query<{
        source_ref: string;
        page_path: string;
        prompt_version: string | null;
      }>(
        `SELECT source_ref, page_path, prompt_version
         FROM page_citations
         WHERE source_binding_id = $1`,
        [bindingId],
      );
      expect(citation.rowCount).toBeGreaterThanOrEqual(1);
      expect(citation.rows[0]?.source_ref).toContain("doc-q4-plan");
      expect(citation.rows[0]?.page_path).toBe("strategy/q4-plan.md");
      expect(citation.rows[0]?.prompt_version).not.toBeNull();

      // intake.status flipped to classified.
      const intake = await e.pgPool.query<{ status: string }>(
        `SELECT status FROM ingestion_intake
         WHERE binding_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [bindingId],
      );
      expect(intake.rows[0]?.status).toBe("classified");

      // Defensive: domainId column exists; the seeded binding's
      // home domain matches what we created above.
      expect(typeof domainId).toBe("string");
    });

    it("cross-domain-write attacker is rejected; NO write reaches `wiki-finance-secrets`", async () => {
      const e = env!;
      await resetForTest(e, { wikiRepos: [GITEA_REPO] });
      await seedDomainAndBinding(e);
      const attacker = await loadCrossDomainWriteFixture();

      const mock = new MockLlmClient();
      // Classifier mock returns the fully-pwned attacker JSON
      // verbatim. Orchestrator's Layer 4 guard MUST reject.
      mock.register({
        match: { model: "gpt-4o-mini", promptIncludes: "opencoo Classifier" },
        response: {
          text: JSON.stringify(attacker.attackerClassifierOutput),
          tokensIn: 50,
          tokensOut: 50,
        },
      });

      const router = new LlmRouter({
        db: e.db as unknown as Parameters<typeof LlmRouter>[0]["db"],
        env: {},
        logger: silentLogger(),
        pauser: {
          paused: () => false,
          pause: () => undefined,
          resume: () => undefined,
        },
        provider: mock,
      });

      const source = createInMemorySource({
        documents: [
          {
            sourceDocId: "doc-attack-cross-domain",
            sourceRevision: "rev-1",
            sourceRef: `drive:${attacker.source}`,
            contentBytes: Buffer.from(attacker.body, "utf8"),
          },
        ],
      });
      const enqueue = makeEnqueue();
      await runScanner({
        db: e.db as unknown as Parameters<typeof runScanner>[0]["db"],
        logger: silentLogger(),
        adapterRegistry: {
          get: (slug) => (slug === "e2e-inmem" ? source : undefined),
        },
        enqueue,
      });
      expect(enqueue.jobs).toHaveLength(1);

      const wikiDeps = buildWikiDeps(e);
      const promise = runCompilationWorker({
        db: e.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router,
        wikiDeps,
        author: { name: "opencoo-e2e", email: "e2e@opencoo.test" },
        guardAdapter: passThroughGuard(),
        job: enqueue.jobs[0]!,
      });
      // The classifier's Layer 4 cross-checks the emitted
      // domain_slug against the binding's allowedDomains
      // (just `wiki-execs`); `wiki-finance-secrets` is not in
      // that set → ClassifierValidationError.
      await expect(promise).rejects.toBeInstanceOf(ClassifierValidationError);

      // No write should have reached the attacker's repo. The
      // repo was never created in the per-test reset, so a 404
      // from Gitea is the proof.
      const probeRes = await fetch(
        `${e.giteaBaseUrl}/api/v1/repos/${e.giteaAdminUser}/wiki-finance-secrets`,
        {
          headers: { Authorization: `token ${e.giteaAdminPat}` },
        },
      );
      expect(probeRes.status).toBe(404);
    });

    it("path-traversal attacker is rejected; NO write reaches a `../`-shaped path", async () => {
      const e = env!;
      await resetForTest(e, { wikiRepos: [GITEA_REPO] });
      await seedDomainAndBinding(e);
      const attacker = await loadPathTraversalFixture();

      // The path-traversal fixture's attackerOutput uses the
      // declared allowed domain (`test-domain`) but a `../`-
      // segmented page_path. The classifier's allowedDomains
      // must therefore include "test-domain" for this run so
      // we exercise the path-guard layer, not the domain
      // layer. We add it as a SECOND seeded binding so the
      // earlier wiki-execs binding's expectations still hold.
      const ptDomain = await e.pgPool.query<{ id: string }>(
        `INSERT INTO domains (slug, name) VALUES ('test-domain', 'Test')
         RETURNING id`,
      );
      const ptDomainId = ptDomain.rows[0]!.id;
      const ptBinding = await e.pgPool.query<{ id: string }>(
        `INSERT INTO sources_bindings
           (domain_id, adapter_slug, source_id, allowed_paths, enabled)
         VALUES ($1::uuid, 'e2e-inmem-pt', 'e2e-folder-pt', $2::text[], true)
         RETURNING id`,
        [ptDomainId, ALLOWED_PATHS],
      );

      const mock = new MockLlmClient();
      mock.register({
        match: { model: "gpt-4o-mini", promptIncludes: "opencoo Classifier" },
        response: {
          text: JSON.stringify(attacker.attackerClassifierOutput),
          tokensIn: 50,
          tokensOut: 50,
        },
      });

      const router = new LlmRouter({
        db: e.db as unknown as Parameters<typeof LlmRouter>[0]["db"],
        env: {},
        logger: silentLogger(),
        pauser: {
          paused: () => false,
          pause: () => undefined,
          resume: () => undefined,
        },
        provider: mock,
      });

      const source = createInMemorySource({
        slug: "e2e-inmem-pt",
        documents: [
          {
            sourceDocId: "doc-attack-path-traversal",
            sourceRevision: "rev-1",
            sourceRef: `drive:${attacker.source}`,
            contentBytes: Buffer.from(attacker.body, "utf8"),
          },
        ],
      });
      const enqueue = makeEnqueue();
      await runScanner({
        db: e.db as unknown as Parameters<typeof runScanner>[0]["db"],
        logger: silentLogger(),
        adapterRegistry: {
          get: (slug) => (slug === "e2e-inmem-pt" ? source : undefined),
        },
        enqueue,
      });
      // The pre-existing wiki-execs binding above is also
      // enabled; runScanner's adapter registry returns
      // undefined for it → it's skipped (logger.warn). The
      // path-traversal binding is the only one with a
      // matching adapter slug.
      const ptJob = enqueue.jobs.find(
        (j) => j.bindingId === ptBinding.rows[0]!.id,
      );
      expect(ptJob).toBeDefined();

      const wikiDeps = buildWikiDeps(e);
      const promise = runCompilationWorker({
        db: e.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router,
        wikiDeps,
        author: { name: "opencoo-e2e", email: "e2e@opencoo.test" },
        guardAdapter: passThroughGuard(),
        job: ptJob!,
      });
      // Path-guard layer fires on `../../wiki-hr/...` →
      // ClassifierPathError. (Spotlight escapes the directive
      // text but the classifier's downstream layer 4 path-guard
      // is what actually rejects the attacker output.)
      await expect(promise).rejects.toBeInstanceOf(ClassifierPathError);

      // No write should have reached a `../`-shaped path. The
      // wiki-test-domain repo was never created; the
      // wiki-execs repo we did create should still be empty
      // (no `strategy/...` page from this test's run). Probe
      // the canonical strategy page — must 404.
      const probe = await fetch(
        `${e.giteaBaseUrl}/api/v1/repos/${e.giteaAdminUser}/${GITEA_REPO}/contents/strategy/q4-plan.md`,
        {
          headers: { Authorization: `token ${e.giteaAdminPat}` },
        },
      );
      expect(probe.status).toBe(404);
    });
  },
);

describe.skipIf(HAS_DOCKER)("e2e — ingest-to-wiki (Docker not available)", () => {
  it("skips when Docker is not available — set up colima or run in CI", () => {
    expect(HAS_DOCKER).toBe(false);
  });
});
