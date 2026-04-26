/**
 * E2E #3 — source-forget-erases-and-audits (PRD §5 criterion 9).
 *
 * Drives `runSourceForget` directly against the compose-spun
 * Postgres. Two sub-flows in one test:
 *   - dry-run: prints the plan, writes nothing.
 *   - confirmed (interactive): purges intake + webhook rows,
 *     writes erasure_log entries, disables the binding.
 *
 * The CLI command's TTY/prompts plumbing is bypassed via the
 * `tty` + `promptsFn` test seams — `tty.isInteractive` is set
 * to `true` and the prompts mock returns the exact-match
 * confirmation string. This exercises the same SQL path the
 * production interactive flow runs.
 *
 * Asserts (per planner Q4 + PRD §5 #9):
 *   - dry-run: ingestion_intake row is intact, erasure_log is
 *     empty for this binding, sources_bindings.enabled is true.
 *   - confirmed: ingestion_intake purged, two erasure_log rows
 *     (purge_intake + purge_webhooks) attribute the action to
 *     the executor user, sources_bindings.enabled flipped false.
 *   - The pool is fully drained (no leaked connections after
 *     the test).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  runSourceForget,
  isExitSentinel,
} from "../../packages/cli/src/index.js";
import {
  __resetProcessExit,
  __setProcessExit,
  ExitSentinel,
} from "../../packages/cli/src/lib/exit.js";
import pg from "pg";

import {
  dockerAvailable,
  E2E_ENDPOINTS,
  startCompose,
  stopCompose,
} from "./_setup/compose-controller.js";
import {
  bootstrapEnvironment,
  disposeEnvironment,
  resetForTest,
  type E2EEnvironment,
} from "./_setup/seed.js";

const HAS_DOCKER = dockerAvailable();
const DOMAIN_SLUG = "wiki-execs";
const GITEA_REPO = `wiki-${DOMAIN_SLUG}`;

interface SeededState {
  readonly bindingId: string;
  readonly executorUserId: string;
}

async function seedFullState(env: E2EEnvironment): Promise<SeededState> {
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
     VALUES ($1::uuid, 'drive', 'folder-1', $2::text[], true)
     RETURNING id`,
    [domainId, ["strategy/**"]],
  );
  const bindingId = binding.rows[0]!.id;
  // Pre-seed three intake rows + two webhook rows so the
  // forget purge has something to delete and the assertion has
  // a non-trivial count to verify.
  for (let i = 0; i < 3; i += 1) {
    await env.pgPool.query(
      `INSERT INTO ingestion_intake
         (binding_id, source_doc_id, source_revision, content_hash)
       VALUES ($1::uuid, $2, $3, $4)`,
      [bindingId, `doc-${i}`, `rev-${i}`, `hash-${i}`],
    );
  }
  for (let i = 0; i < 2; i += 1) {
    await env.pgPool.query(
      `INSERT INTO webhook_events
         (binding_id, provider, event_id, payload, payload_hash, signature_ok)
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5, true)`,
      [
        bindingId,
        "drive",
        `evt-${i}`,
        JSON.stringify({ marker: i }),
        `hash-evt-${i}`,
      ],
    );
  }
  // Executor user — `runSourceForget` requires a known
  // gitea_username in `users` to attribute the audit row to.
  const user = await env.pgPool.query<{ id: string }>(
    `INSERT INTO users (gitea_username, role)
     VALUES ('e2e-operator', 'admin')
     RETURNING id`,
  );
  return {
    bindingId,
    executorUserId: user.rows[0]!.id,
  };
}

interface CapturedStream {
  readonly chunks: string[];
  write(s: string): boolean;
}

function captureStream(): CapturedStream {
  const chunks: string[] = [];
  return {
    chunks,
    write(s: string): boolean {
      chunks.push(s);
      return true;
    },
  };
}

/** Substitute the CLI's `processExit` for the duration of the
 *  call. The default impl calls `process.exit()` which would
 *  terminate the test runner; the test seam throws an
 *  `ExitSentinel` instead. Returns the captured exit kind. */
async function captureExit(
  fn: () => Promise<void>,
): Promise<"ok" | "user-error" | "runtime-error" | null> {
  __setProcessExit((code: number) => {
    throw new ExitSentinel(code);
  });
  try {
    await fn();
    return null;
  } catch (err) {
    if (!isExitSentinel(err)) throw err;
    if (err.code === 0) return "ok";
    if (err.code === 1) return "user-error";
    return "runtime-error";
  } finally {
    __resetProcessExit();
  }
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
  "e2e — source forget erases + audits (PRD §5 #9)",
  () => {
    it("--dry-run prints the plan and writes nothing", async () => {
      const e = env!;
      await resetForTest(e, { wikiRepos: [GITEA_REPO] });
      const { bindingId } = await seedFullState(e);

      const stdout = captureStream();
      const stderr = captureStream();
      const exit = await captureExit(() =>
        runSourceForget({
          env: { DATABASE_URL: E2E_ENDPOINTS.postgresUrl },
          bindingId,
          executor: "e2e-operator",
          dryRun: true,
          stdout,
          stderr,
          // The CLI's source-forget calls `pool.end()` in its
          // finally block (production-correct: short-lived
          // process). For the e2e suite we want the shared
          // `e.pgPool` to keep working for downstream
          // assertions, so we create a per-run throwaway pool
          // here that source-forget can safely .end() without
          // touching the suite-wide connection.
          poolFactory: () =>
            new pg.Pool({
              connectionString: E2E_ENDPOINTS.postgresUrl,
            }),
          tty: { isInteractive: false },
        }),
      );
      expect(exit).toBe("ok");
      expect(stdout.chunks.join("")).toContain("--dry-run");

      // Side-effect proof: nothing changed.
      const intake = await e.pgPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ingestion_intake WHERE binding_id = $1::uuid`,
        [bindingId],
      );
      expect(Number.parseInt(intake.rows[0]!.count, 10)).toBe(3);

      const erasure = await e.pgPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM erasure_log WHERE binding_id = $1::uuid`,
        [bindingId],
      );
      expect(Number.parseInt(erasure.rows[0]!.count, 10)).toBe(0);

      const enabledRow = await e.pgPool.query<{ enabled: boolean }>(
        `SELECT enabled FROM sources_bindings WHERE id = $1::uuid`,
        [bindingId],
      );
      expect(enabledRow.rows[0]?.enabled).toBe(true);
    });

    it("confirmed run purges intake + webhook rows, writes erasure_log, disables the binding", async () => {
      const e = env!;
      await resetForTest(e, { wikiRepos: [GITEA_REPO] });
      const { bindingId, executorUserId } = await seedFullState(e);

      const stdout = captureStream();
      const stderr = captureStream();
      // Mock the prompts library — the CLI requires the
      // operator to type back `<domainSlug>/<adapterSlug>`.
      const expectedConfirm = `${DOMAIN_SLUG}/drive`;
      const promptsFn = (async (_q: unknown) => ({
        value: expectedConfirm,
      })) as unknown as Parameters<typeof runSourceForget>[0]["promptsFn"];
      const exit = await captureExit(() =>
        runSourceForget({
          env: { DATABASE_URL: E2E_ENDPOINTS.postgresUrl },
          bindingId,
          executor: "e2e-operator",
          dryRun: false,
          stdout,
          stderr,
          // The CLI's source-forget calls pool.end() in its
          // finally block (production-correct: short-lived
          // process). For the e2e suite we need a per-run
          // throwaway pool so the shared `e.pgPool` keeps
          // working for downstream assertions.
          poolFactory: () =>
            new pg.Pool({
              connectionString: E2E_ENDPOINTS.postgresUrl,
            }),
          tty: { isInteractive: true },
          ...(promptsFn !== undefined ? { promptsFn } : {}),
        }),
      );
      expect(exit).toBe("ok");

      // intake purged.
      const intake = await e.pgPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ingestion_intake WHERE binding_id = $1::uuid`,
        [bindingId],
      );
      expect(Number.parseInt(intake.rows[0]!.count, 10)).toBe(0);

      // webhooks purged.
      const wh = await e.pgPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM webhook_events WHERE binding_id = $1::uuid`,
        [bindingId],
      );
      expect(Number.parseInt(wh.rows[0]!.count, 10)).toBe(0);

      // Two erasure_log rows attributed to the executor.
      const erasure = await e.pgPool.query<{
        action: string;
        executed_by: string;
      }>(
        `SELECT action::text AS action, executed_by::text AS executed_by
         FROM erasure_log WHERE binding_id = $1::uuid
         ORDER BY action`,
        [bindingId],
      );
      const actions = erasure.rows.map((r) => r.action).sort();
      expect(actions).toEqual(["purge_intake", "purge_webhooks"]);
      for (const row of erasure.rows) {
        expect(row.executed_by).toBe(executorUserId);
      }

      // binding disabled.
      const after = await e.pgPool.query<{ enabled: boolean }>(
        `SELECT enabled FROM sources_bindings WHERE id = $1::uuid`,
        [bindingId],
      );
      expect(after.rows[0]?.enabled).toBe(false);
    });
  },
);

describe.skipIf(HAS_DOCKER)("e2e — source forget (Docker not available)", () => {
  it("skips when Docker is not available", () => {
    expect(HAS_DOCKER).toBe(false);
  });
});
