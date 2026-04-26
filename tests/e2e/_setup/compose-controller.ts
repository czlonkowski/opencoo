/**
 * Phase-a e2e ship-gate compose controller (PR 32 / plan #149).
 *
 * Brings up `compose.e2e.yml` (postgres + redis + gitea) and
 * waits for every service's healthcheck to flip to `healthy`.
 * The test process then drives the pipelines directly in-band
 * — there are no engine subprocesses (planner Q3 + Q6: this is
 * what shaves ~4 min off the wall-clock budget).
 *
 * Concurrency note: `pnpm test:e2e` uses a single-fork vitest
 * config so only ONE test file is alive at a time. The
 * controller is a module-level singleton — `startCompose()` is
 * idempotent within a process; `stopCompose()` runs on
 * teardown. CI's release.yml additionally `compose down -v`
 * after the suite to cover any abnormal-exit case.
 *
 * Health gating uses `docker inspect --format` against each
 * container's `.State.Health.Status`. Compose's own
 * `--wait` flag also exists but is not granular enough: a
 * compose-level wait fails opaquely if any service times out;
 * polling per-container surfaces which one is unhealthy.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const COMPOSE_FILE = "compose.e2e.yml";

const SERVICES = ["postgres", "redis", "gitea"] as const;
type Service = (typeof SERVICES)[number];

const CONTAINER_NAMES: Readonly<Record<Service, string>> = {
  postgres: "opencoo-e2e-postgres",
  redis: "opencoo-e2e-redis",
  gitea: "opencoo-e2e-gitea",
};

/** Connection coordinates the seed + tests use to reach the
 *  compose-managed services. Host-side ports are picked above
 *  the typical local-dev defaults so a developer running
 *  `localhost:5432` for their daily Postgres can still run the
 *  e2e suite. */
export const E2E_ENDPOINTS = {
  postgresUrl: "postgres://opencoo:opencoo@localhost:55432/opencoo_e2e",
  redisUrl: "redis://localhost:56379",
  giteaBaseUrl: "http://localhost:53000",
} as const;

export class ComposeError extends Error {
  override readonly name = "ComposeError";
}

function repoRoot(): string {
  // tests/e2e/_setup → repo root is three levels up.
  // Resolved once at module load; no need to memoise.
  // import.meta.url is `file:///abs/path/.../compose-controller.ts`.
  const here = new URL(".", import.meta.url).pathname;
  return join(here, "..", "..", "..");
}

function runDocker(
  args: ReadonlyArray<string>,
): SpawnSyncReturns<string> {
  return spawnSync("docker", args as string[], {
    cwd: repoRoot(),
    encoding: "utf8",
    env: process.env,
  });
}

function runCompose(
  args: ReadonlyArray<string>,
): SpawnSyncReturns<string> {
  return runDocker(["compose", "-f", COMPOSE_FILE, ...args]);
}

function assertComposeFile(): void {
  const file = join(repoRoot(), COMPOSE_FILE);
  if (!existsSync(file)) {
    throw new ComposeError(
      `compose file not found at ${file} — e2e harness must run from repo root`,
    );
  }
}

/** Container's healthcheck `Status` (lowercase per docker
 *  inspect). Returns `null` if the container does not exist or
 *  has no healthcheck. */
function inspectHealth(container: string): string | null {
  const res = runDocker([
    "inspect",
    "--format",
    "{{.State.Health.Status}}",
    container,
  ]);
  if (res.status !== 0) return null;
  const v = res.stdout.trim();
  return v.length === 0 ? null : v;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const remaining = new Set<Service>(SERVICES);
  let lastStatuses: string[] = [];
  while (Date.now() < deadline) {
    for (const svc of [...remaining]) {
      const status = inspectHealth(CONTAINER_NAMES[svc]);
      if (status === "healthy") {
        remaining.delete(svc);
      }
    }
    if (remaining.size === 0) return;
    lastStatuses = SERVICES.map(
      (s) => `${s}=${inspectHealth(CONTAINER_NAMES[s]) ?? "missing"}`,
    );
    await sleep(500);
  }
  throw new ComposeError(
    `services did not become healthy within ${timeoutMs}ms (last seen: ${lastStatuses.join(", ")})`,
  );
}

/** Bring up the e2e compose stack and wait for every service's
 *  healthcheck. Idempotent — calling twice in the same process
 *  returns immediately on the second call (docker compose's
 *  `up -d` is itself idempotent). */
export async function startCompose(
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  assertComposeFile();
  const up = runCompose(["up", "-d", "--wait"]);
  if (up.status !== 0) {
    throw new ComposeError(
      `docker compose up failed (exit ${up.status})\nSTDOUT:\n${up.stdout}\nSTDERR:\n${up.stderr}`,
    );
  }
  // `--wait` already gates on the compose healthcheck status,
  // but we re-poll to surface a helpful per-service message if
  // a slower environment misses the compose default.
  // Defaults: 90s for the workstation case (warm caches);
  // 300s when CI=truthy (cold image pulls + slower runner).
  // Callers can override via `options.timeoutMs`.
  const ciDefault = process.env["CI"] !== undefined && process.env["CI"] !== ""
    ? 300_000
    : 90_000;
  await waitForHealthy(options.timeoutMs ?? ciDefault);
}

/** Tear down the compose stack — `down -v` removes anonymous
 *  volumes so the next run starts from a fresh Gitea + Postgres
 *  state. Best-effort on the docker side: if the daemon is
 *  already gone (CI runner shutdown), we swallow rather than
 *  fail the test summary. */
export async function stopCompose(): Promise<void> {
  assertComposeFile();
  const res = runCompose(["down", "-v", "--remove-orphans"]);
  if (res.status !== 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `docker compose down emitted non-zero exit ${res.status}; continuing.`,
      res.stderr,
    );
  }
}

/** True when `docker info` succeeds; tests use this to skip
 *  cleanly with an actionable message when Docker isn't
 *  available (CI without the docker layer; a local machine
 *  with colima not started). */
export function dockerAvailable(): boolean {
  return runDocker(["info"]).status === 0;
}
