/**
 * @opencoo/cli tests (PR 30 / plan #135).
 *
 * Per-command parse smoke + load-bearing security invariants:
 *   - `source forget` non-interactive without --dry-run → exit 1
 *   - `setup` writes .env at mode 0600
 *   - `doctor` redaction: secret VALUES never appear in stdout
 *   - `doctor` exits 1 on any error-level check, 0 on warn-only
 *   - `source forget` writes `erasure_log` rows + disables binding
 *   - `recompile` requires either selector OR --all-in-domain
 */
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExitSentinel,
  __resetProcessExit,
  __setProcessExit,
} from "../src/lib/exit.js";
import { runSetup } from "../src/commands/setup.js";
import { runDoctor } from "../src/commands/doctor.js";
import {
  formatSecret,
  inspectSecret,
} from "../src/lib/credential-redact.js";
import {
  composeStartedEngineWithBundle,
  runServe,
  type ServeArgs,
} from "../src/commands/serve.js";
import { runSourceForget } from "../src/commands/source-forget.js";
import { runRecompile } from "../src/commands/recompile.js";
import { parseAndDispatch } from "../src/parse.js";

class CapturingStream {
  buffer = "";
  write = (s: string): boolean => {
    this.buffer += s;
    return true;
  };
}

interface ExitCapture {
  code: number | null;
}

function captureExit(): ExitCapture {
  const cap: ExitCapture = { code: null };
  __setProcessExit(((code: number) => {
    cap.code = code;
    // Throw the public ExitSentinel so the runtime helpers'
    // catch blocks (which check `isExitSentinel(err)`) re-raise
    // the sentinel rather than treating it as a runtime error.
    throw new ExitSentinel(code);
  }) as never);
  return cap;
}

afterEach(() => {
  __resetProcessExit();
});

// ---------------------------------------------------------------------------
// credential-redact helpers
// ---------------------------------------------------------------------------

describe("credential-redact (load-bearing)", () => {
  it("inspectSecret reports `unset` when neither X nor X_FILE is set", () => {
    const r = inspectSecret({}, "FOO");
    expect(r.source).toBe("unset");
    expect(r.bytes).toBe(0);
  });

  it("inspectSecret reports `env` + bytes-only when X is set", () => {
    const r = inspectSecret({ FOO: "abcdef" }, "FOO");
    expect(r.source).toBe("env");
    expect(r.bytes).toBe(6);
    // The value itself is NOT exposed by the structured output.
    expect((r as unknown as { value?: unknown }).value).toBeUndefined();
  });

  it("formatSecret NEVER includes the secret VALUE", () => {
    const SECRET_VALUE = "super-secret-do-not-leak";
    const r = inspectSecret({ FOO: SECRET_VALUE }, "FOO");
    const formatted = formatSecret(r);
    expect(formatted).not.toContain(SECRET_VALUE);
    expect(formatted).toContain("FOO");
    expect(formatted).toContain(`${SECRET_VALUE.length} bytes`);
  });
});

// ---------------------------------------------------------------------------
// `setup` — writes .env at mode 0600
// ---------------------------------------------------------------------------

describe("runSetup", () => {
  it("non-interactive --yes writes .env at mode 0600 with the env values", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const writes: Array<{ path: string; data: string; mode: number }> = [];
    const exit = captureExit();
    try {
      await runSetup({
        cwd: "/tmp/test-cwd",
        env: {
          DATABASE_URL: "postgres://x",
          REDIS_URL: "redis://y",
          GITEA_URL: "https://gitea.test",
          ADMIN_TEAM_SLUG: "opencoo-admins",
          GITEA_BASE_URL: "https://gitea.test",
        },
        nonInteractive: true,
        stdout,
        stderr,
        existsSync: () => false,
        writeFile: (p, data, mode) => writes.push({ path: p, data, mode }),
        randomBytes: (n) => Buffer.alloc(n, 0xab),
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/tmp/test-cwd/.env");
    expect(writes[0]?.mode).toBe(0o600);
    expect(writes[0]?.data).toContain("DATABASE_URL=postgres://x");
    expect(writes[0]?.data).toContain("REDIS_URL=redis://y");
    expect(writes[0]?.data).toContain("ADMIN_TEAM_SLUG=opencoo-admins");
    // Generated keys present.
    expect(writes[0]?.data).toContain("ENCRYPTION_KEY=");
    expect(writes[0]?.data).toContain("SESSION_HMAC_KEY=");
  });

  it("non-interactive --yes errors when a required var is missing in env", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runSetup({
        cwd: "/tmp/test-cwd",
        env: {}, // no required vars
        nonInteractive: true,
        stdout,
        stderr,
        existsSync: () => false,
        writeFile: () => undefined,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(1);
    expect(stderr.buffer).toContain("missing");
  });

  it("interactive (default) refuses to overwrite an existing .env", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runSetup({
        cwd: "/tmp/test-cwd",
        env: {},
        nonInteractive: false,
        stdout,
        stderr,
        existsSync: () => true, // pretend .env already there
        writeFile: () => undefined,
        promptsFn: vi.fn() as unknown as Parameters<typeof runSetup>[0]["promptsFn"],
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(1);
    expect(stderr.buffer).toContain("already exists");
  });
});

// ---------------------------------------------------------------------------
// `doctor` — never prints secret values; exits 1 on errors
// ---------------------------------------------------------------------------

describe("runDoctor", () => {
  it("prints redacted secret summaries — VALUES NEVER LEAK", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    const SECRET = "ENC-KEY-do-not-leak-1234";
    try {
      await runDoctor({
        env: {
          DATABASE_URL: "postgres://localhost",
          ENCRYPTION_KEY: SECRET,
          REDIS_URL: "redis://localhost",
          GITEA_URL: "https://gitea.test",
          ADMIN_TEAM_SLUG: "admins",
          SESSION_HMAC_KEY: "hmac-secret",
          GITEA_BASE_URL: "https://gitea.test",
        },
        json: false,
        stdout,
        stderr,
        // Stub the DB checks so they fail-cleanly without a
        // real connection.
        poolFactory: () =>
          ({
            query: async (): Promise<unknown> => {
              throw new Error("test pool unreachable");
            },
            end: async (): Promise<void> => undefined,
          }) as unknown as Parameters<typeof runDoctor>[0] extends infer P
            ? P extends { poolFactory?: infer F }
              ? F extends (...a: unknown[]) => infer R
                ? R
                : never
              : never
            : never,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    // Combined stdout+stderr must not echo the secret value.
    const combined = stdout.buffer + stderr.buffer;
    expect(combined).not.toContain(SECRET);
    expect(combined).not.toContain("hmac-secret");
    // But the secret NAMES must surface — operator needs to
    // see what's set.
    expect(combined).toContain("ENCRYPTION_KEY");
    expect(combined).toContain("SESSION_HMAC_KEY");
    // DB-unreachable → error → exit 1.
    expect(exit.code).toBe(1);
  });

  it("--json emits a structured DoctorReport", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runDoctor({
        env: {
          DATABASE_URL: "postgres://localhost",
          ENCRYPTION_KEY: "x",
          REDIS_URL: "redis://localhost",
          GITEA_URL: "https://gitea.test",
          ADMIN_TEAM_SLUG: "admins",
          SESSION_HMAC_KEY: "hmac",
          GITEA_BASE_URL: "https://gitea.test",
        },
        json: true,
        stdout,
        stderr,
        // Both `SELECT 1 AS ok` and `SELECT COUNT(*) FROM drizzle.__drizzle_migrations`
        // route through this stub — return the union shape so
        // both checks see what they expect.
        poolFactory: () =>
          ({
            query: async () => ({ rows: [{ ok: 1, count: "6" }] }),
            end: async () => undefined,
          }) as unknown as Parameters<typeof runDoctor>[0] extends infer P
            ? P extends { poolFactory?: infer F }
              ? F extends (...a: unknown[]) => infer R
                ? R
                : never
              : never
            : never,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    const parsed = JSON.parse(stdout.buffer) as { checks: unknown[]; internetFacing: string[] };
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.internetFacing).toContain("/api/admin/_csrf");
    expect(parsed.internetFacing).toContain("/health");
    expect(exit.code).toBe(0);
  });

  it("warns (not errors) when no admin PAT is provided for the team-check", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runDoctor({
        env: {
          DATABASE_URL: "postgres://localhost",
          ENCRYPTION_KEY: "x",
          REDIS_URL: "redis://localhost",
          GITEA_URL: "https://gitea.test",
          ADMIN_TEAM_SLUG: "admins",
          SESSION_HMAC_KEY: "hmac",
          GITEA_BASE_URL: "https://gitea.test",
        },
        json: false,
        stdout,
        stderr,
        poolFactory: () =>
          ({
            query: async () => ({ rows: [{ ok: 1, count: "6" }] }),
            end: async () => undefined,
          }) as unknown as Parameters<typeof runDoctor>[0] extends infer P
            ? P extends { poolFactory?: infer F }
              ? F extends (...a: unknown[]) => infer R
                ? R
                : never
              : never
            : never,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    // Warn-only → exit 0.
    expect(exit.code).toBe(0);
    expect(stderr.buffer).toContain("gitea_team");
    expect(stderr.buffer).toContain("skipped");
  });
});

// ---------------------------------------------------------------------------
// `source forget` — non-interactive without --dry-run → exit 1 (TTY guard)
// ---------------------------------------------------------------------------

describe("runSourceForget — TTY guard (load-bearing)", () => {
  it("non-interactive (no TTY, no --dry-run) → exit 1", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runSourceForget({
        env: {},
        bindingId: "00000000-0000-0000-0000-000000000000",
        executor: "alice",
        dryRun: false,
        stdout,
        stderr,
        tty: { isInteractive: false },
        // The pool factory is never reached because the TTY
        // check exits FIRST. Provide a stub so the test
        // doesn't accidentally hit a real DB.
        poolFactory: () => {
          throw new Error("pool should not be opened on TTY-guard exit");
        },
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(1);
    expect(stderr.buffer).toContain("non-interactive");
    expect(stderr.buffer).toContain("--dry-run");
  });

  it("non-interactive WITH --dry-run is allowed (lookup only, no destructive writes)", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    const queries: Array<{ sql: string }> = [];
    try {
      await runSourceForget({
        env: {},
        bindingId: "00000000-0000-0000-0000-000000000000",
        executor: "alice",
        dryRun: true,
        stdout,
        stderr,
        tty: { isInteractive: false },
        poolFactory: () =>
          ({
            connect: async () =>
              ({
                query: async (sql: string) => {
                  queries.push({ sql: sql.split("\n")[0] ?? "" });
                  if (sql.includes("FROM sources_bindings")) {
                    return {
                      rows: [
                        {
                          id: "00000000-0000-0000-0000-000000000000",
                          adapter_slug: "drive",
                          domain_slug: "exec",
                        },
                      ],
                    };
                  }
                  if (sql.includes("FROM ingestion_intake")) {
                    return { rows: [{ count: "5" }] };
                  }
                  if (sql.includes("FROM webhook_events")) {
                    return { rows: [{ count: "0" }] };
                  }
                  return { rows: [] };
                },
                release: () => undefined,
              }),
            end: async () => undefined,
          }) as unknown as Parameters<typeof runSourceForget>[0] extends infer P
            ? P extends { poolFactory?: infer F }
              ? F extends (...a: unknown[]) => infer R
                ? R
                : never
              : never
            : never,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(0);
    expect(stdout.buffer).toContain("--dry-run");
    expect(stdout.buffer).toContain("5 rows to purge");
    // Critically — no DELETE / UPDATE was issued.
    const destructiveQueries = queries.filter(
      (q) =>
        q.sql.startsWith("DELETE") ||
        q.sql.startsWith("UPDATE") ||
        q.sql.startsWith("INSERT INTO erasure_log"),
    );
    expect(destructiveQueries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `recompile` — selector validation
// ---------------------------------------------------------------------------

describe("runRecompile", () => {
  it("requires either <selector> or --all-in-domain", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runRecompile({
        env: {},
        selector: null,
        allInDomain: null,
        executor: "alice",
        stdout,
        stderr,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(1);
    expect(stderr.buffer).toContain("either");
  });

  it("rejects mutually-exclusive selector + --all-in-domain", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runRecompile({
        env: {},
        selector: "exec:processes/onboarding.md",
        allInDomain: "exec",
        executor: "alice",
        stdout,
        stderr,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(1);
    expect(stderr.buffer).toContain("mutually exclusive");
  });
});

// ---------------------------------------------------------------------------
// commander parse layer
// ---------------------------------------------------------------------------

describe("parseAndDispatch", () => {
  it("dispatches `migrate` to the migrate runner", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const migrate = vi.fn(async () => undefined);
    await parseAndDispatch({
      argv: ["migrate"],
      env: {},
      cwd: "/tmp",
      version: "0.0.0-test",
      stdout,
      stderr,
      runners: { migrate },
    });
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate.mock.calls[0]?.[0].skipMigrate).toBe(false);
  });

  it("--skip-migrate threads the flag through", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const migrate = vi.fn(async () => undefined);
    await parseAndDispatch({
      argv: ["migrate", "--skip-migrate"],
      env: {},
      cwd: "/tmp",
      version: "0.0.0-test",
      stdout,
      stderr,
      runners: { migrate },
    });
    expect(migrate.mock.calls[0]?.[0].skipMigrate).toBe(true);
  });

  it("`source forget` requires --executor", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const sourceForget = vi.fn(async () => undefined);
    await expect(
      parseAndDispatch({
        argv: ["source", "forget", "abc"],
        env: {},
        cwd: "/tmp",
        version: "0.0.0-test",
        stdout,
        stderr,
        runners: { sourceForget },
      }),
    ).rejects.toThrow();
    expect(sourceForget).not.toHaveBeenCalled();
  });

  it("`doctor --json` threads json=true through", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const doctor = vi.fn(async () => undefined);
    await parseAndDispatch({
      argv: ["doctor", "--json"],
      env: {},
      cwd: "/tmp",
      version: "0.0.0-test",
      stdout,
      stderr,
      runners: { doctor },
    });
    expect(doctor.mock.calls[0]?.[0].json).toBe(true);
  });

  it("bare `opencoo` (no subcommand) dispatches to runServe", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const serve = vi.fn(async () => undefined);
    await parseAndDispatch({
      argv: [],
      env: { DATABASE_URL: "postgres://x" },
      cwd: "/tmp",
      version: "0.0.0-test",
      stdout,
      stderr,
      runners: { serve },
    });
    expect(serve).toHaveBeenCalledTimes(1);
    expect(serve.mock.calls[0]?.[0].env).toEqual({
      DATABASE_URL: "postgres://x",
    });
  });
});

// ---------------------------------------------------------------------------
// runServe — bare `opencoo` boot verb (PR phase-a-appendix / plan radiant-diffie)
// ---------------------------------------------------------------------------

/** Minimal test-double for the `StartedEngine` shape `runServe`
 *  consumes. Captures `close()` invocations so the test can
 *  assert the signal handler wired correctly. */
interface FakeEngine {
  readonly close: ReturnType<typeof vi.fn>;
}

function makeFakeEngine(): FakeEngine {
  return { close: vi.fn(async () => undefined) };
}

/** Helper — drains the microtask queue so any pending listener
 *  registrations (the `.on("SIGTERM", ...)` calls inside
 *  runServe) settle before the test emits the signal. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("runServe", () => {
  // Helper — every legacy test passes a no-op ingestion factory
  // since PR-M1 added co-boot but the legacy tests only assert
  // self-op behaviour. See "co-boots engine-ingestion alongside
  // engine-self-operating" below for the multi-engine assertion.
  const noopIngestionFactory = (): Awaited<
    ReturnType<NonNullable<ServeArgs["startIngestionFactory"]>>
  > => makeFakeEngine() as unknown as Awaited<
    ReturnType<NonNullable<ServeArgs["startIngestionFactory"]>>
  >;

  it("wires SIGTERM to engine.close + exitOk(0)", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const engine = makeFakeEngine();
    const startFactory = vi.fn(
      async () => engine as unknown as Awaited<ReturnType<ServeArgs["startFactory"]>>,
    );
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const env = {
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://y",
      GITEA_URL: "https://gitea.test",
      ENCRYPTION_KEY: "0".repeat(64),
      PORT: "8080",
    };

    const serve = runServe({
      env,
      stdout,
      stderr,
      startFactory,
      startIngestionFactory: vi.fn(async () => noopIngestionFactory()),
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    // Let runServe finish awaiting startFactory + register listeners.
    await flushMicrotasks();
    await flushMicrotasks();

    expect(startFactory).toHaveBeenCalledTimes(1);
    expect(startFactory.mock.calls[0]?.[0]?.env).toBe(env);

    // Emit SIGTERM — runServe must call engine.close() then exit(0).
    signalSource.emit("SIGTERM");
    await serve;

    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent on repeated SIGTERM (no double-close)", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const engine = makeFakeEngine();
    const startFactory = vi.fn(
      async () => engine as unknown as Awaited<ReturnType<ServeArgs["startFactory"]>>,
    );
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const serve = runServe({
      env: { DATABASE_URL: "postgres://x" },
      stdout,
      stderr,
      startFactory,
      startIngestionFactory: vi.fn(async () => noopIngestionFactory()),
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    // Two SIGTERMs back-to-back — runServe must dispatch shutdown
    // exactly once. (engine.close() being internally memoised in
    // engine-scaffold is not enough: removing-then-adding the
    // listener in shutdown is racy if both signal handlers fire
    // before the removeListener calls run.)
    signalSource.emit("SIGTERM");
    signalSource.emit("SIGTERM");
    await serve;

    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("surfaces start failures via exitRuntimeError(2) + stderr", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const startFactory = vi.fn(async () => {
      throw new Error("DATABASE_URL invalid");
    });
    const exit = captureExit();
    const signalSource = new EventEmitter();

    try {
      await runServe({
        env: { DATABASE_URL: "bogus" },
        stdout,
        stderr,
        startFactory: startFactory as unknown as ServeArgs["startFactory"],
        signalSource,
        // No `exit` test seam — use the captureExit /
        // __setProcessExit path so we hit the production
        // exit-code routing (exitRuntimeError → ExitSentinel(2)).
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(2);
    expect(stderr.buffer).toContain("DATABASE_URL invalid");
  });

  // PR-M1, phase-a appendix #5 — co-boot of engine-ingestion
  // alongside engine-self-operating. The orchestrator constructs
  // shared pg/Redis/SseBus and threads them into both engines.
  it("co-boots engine-ingestion alongside engine-self-operating", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const selfOpEngine = makeFakeEngine();
    const ingestionEngine = makeFakeEngine();
    const startFactory = vi.fn(
      async () => selfOpEngine as unknown as Awaited<
        ReturnType<ServeArgs["startFactory"]>
      >,
    );
    const startIngestionFactory = vi.fn(
      async () => ingestionEngine as unknown as Awaited<
        ReturnType<ServeArgs["startFactory"]>
      >,
    );
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const env = {
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://y",
      GITEA_URL: "https://gitea.test",
      ENCRYPTION_KEY: "0".repeat(64),
      PORT: "8080",
    };

    const serve = runServe({
      env,
      stdout,
      stderr,
      startFactory,
      startIngestionFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(startFactory).toHaveBeenCalledTimes(1);
    expect(startIngestionFactory).toHaveBeenCalledTimes(1);

    signalSource.emit("SIGTERM");
    await serve;

    // Both engines closed on shutdown.
    expect(selfOpEngine.close).toHaveBeenCalledTimes(1);
    expect(ingestionEngine.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  // Round-2 fix #1 (PR-M2 follow-up) — the orchestrator MUST
  // forward the self-op engine's SseBus into the ingestion factory
  // call so per-job lifecycle events (compile / scanner / etc.)
  // emitted by the PR-M1 sse-bridge land on the SAME bus the
  // management UI streams from. Without this thread the bridge has
  // no bus to emit on and the Activity feed misses ingestion runs.
  it("forwards self-op SseBus into the ingestion factory args (round-2 fix)", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    // Self-op engine carries a sentinel `sseBus` object — the
    // orchestrator should pass it verbatim to the ingestion
    // factory. Identity comparison verifies the SAME instance
    // reaches both ends, not a clone.
    const sseBus = {
      emitRunEvent: vi.fn(),
    };
    const selfOpEngine = {
      ...makeFakeEngine(),
      sseBus,
    };
    const ingestionEngine = makeFakeEngine();
    const startFactory = vi.fn(
      async () => selfOpEngine as unknown as Awaited<
        ReturnType<ServeArgs["startFactory"]>
      >,
    );
    const startIngestionFactory = vi.fn(
      async () => ingestionEngine as unknown as Awaited<
        ReturnType<ServeArgs["startFactory"]>
      >,
    );
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const serve = runServe({
      env: { DATABASE_URL: "postgres://x" },
      stdout,
      stderr,
      startFactory,
      startIngestionFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    // The factory was called with the SAME sseBus instance the
    // self-op engine exposed. Identity comparison (`toBe`) — a
    // structural-equal clone would silently drop emit-event
    // routing in production.
    expect(startIngestionFactory).toHaveBeenCalledTimes(1);
    const ingestionCall = startIngestionFactory.mock.calls[0]?.[0] as {
      readonly sseBus?: typeof sseBus;
    };
    expect(ingestionCall.sseBus).toBe(sseBus);

    signalSource.emit("SIGTERM");
    await serve;
  });

  // Round-2 fix #1 corollary — when self-op DOESN'T expose a bus
  // (test seam / boot-tolerance fallback), the orchestrator omits
  // the field entirely rather than passing `sseBus: undefined`.
  // This matches `exactOptionalPropertyTypes` semantics in the
  // factory's TS surface.
  it("omits sseBus from ingestion args when self-op did not expose one", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const selfOpEngine = makeFakeEngine(); // no sseBus
    const ingestionEngine = makeFakeEngine();
    const startFactory = vi.fn(
      async () => selfOpEngine as unknown as Awaited<
        ReturnType<ServeArgs["startFactory"]>
      >,
    );
    const startIngestionFactory = vi.fn(
      async () => ingestionEngine as unknown as Awaited<
        ReturnType<ServeArgs["startFactory"]>
      >,
    );
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const serve = runServe({
      env: { DATABASE_URL: "postgres://x" },
      stdout,
      stderr,
      startFactory,
      startIngestionFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    const ingestionCall = startIngestionFactory.mock.calls[0]?.[0] as {
      readonly sseBus?: unknown;
    };
    expect("sseBus" in ingestionCall).toBe(false);

    signalSource.emit("SIGTERM");
    await serve;
  });

  // PR-N3 (phase-a appendix #6) — the orchestrator's
  // `defaultStartFactory` composes the production
  // AgentRunnerRegistry from env BEFORE calling
  // `engine-self-operating.start({...})`. The two assertions
  // below pin the boot-tolerance contract — present token →
  // populated bundle threaded into start; missing token → null
  // bundle + warn line surfaced by the upstream helper.
  //
  // These tests drive the same composition helper the default
  // factory invokes, so the wiring path is identical.
  it("composes a populated AgentRunnerRegistry when MCP_BEARER_TOKEN is set (PR-N3 + PR-O3)", async () => {
    const composition = await import(
      "../src/provision/production-composition.js"
    );
    const records: Array<{ message: string }> = [];
    const captureLogger = {
      debug: (m: string): void => void records.push({ message: m }),
      info: (m: string): void => void records.push({ message: m }),
      warn: (m: string): void => void records.push({ message: m }),
      error: (m: string): void => void records.push({ message: m }),
    } as unknown as Parameters<
      typeof composition.tryComposeAgentRunnersBundleFromEnv
    >[0]["logger"];
    const bundle = await composition.tryComposeAgentRunnersBundleFromEnv({
      env: {
        DATABASE_URL: "postgres://test:test@localhost:65535/none",
        MCP_BEARER_TOKEN: "static-bearer-do-not-leak",
        MCP_BASE_URL: "http://localhost:3000/mcp",
        // N8N_MCP_BASE_URL / N8N_MCP_BEARER_TOKEN intentionally
        // absent — PR-O3 falls back to the vendored builderSkills
        // baseline so Surfacer remains REGISTERED (the n8n_mcp.unavailable
        // warn is emitted instead of surfacer.template_catalog_empty).
      },
      logger: captureLogger,
    });
    expect(bundle).not.toBeNull();
    expect(bundle?.runners.get("heartbeat")).toBeTypeOf("function");
    expect(bundle?.runners.get("lint")).toBeTypeOf("function");
    // PR-O3 (phase-a appendix #7): Surfacer is now REGISTERED by
    // default — the vendored builderSkills baseline is non-empty
    // (3 entries), so the surfacerEnabled path activates even
    // when n8n-mcp env vars are unset.
    expect(bundle?.runners.get("surfacer")).toBeTypeOf("function");
    // The 3 definitions stay registered (Lint reads them for
    // automation_drift).
    expect(bundle?.definitions.list().length).toBe(3);
    // No `mcp_http.unavailable` warn — the bundle was composed.
    expect(
      records.find((r) => r.message === "mcp_http.unavailable"),
    ).toBeUndefined();
    // PR-O3: with n8n-mcp env vars unset, the orchestrator emits
    // `n8n_mcp.unavailable` so the operator sees why Surfacer is
    // using the vendored baseline.
    expect(
      records.find((r) => r.message === "n8n_mcp.unavailable"),
    ).toBeDefined();
    // surfacer.template_catalog_empty should NOT be emitted —
    // builderSkills.length > 0.
    expect(
      records.find((r) => r.message === "surfacer.template_catalog_empty"),
    ).toBeUndefined();
    await bundle?.close();
  });

  it("returns a null bundle + logs mcp_http.unavailable when MCP_BEARER_TOKEN is missing (PR-N3 boot-tolerance)", async () => {
    const composition = await import(
      "../src/provision/production-composition.js"
    );
    const records: Array<{ level: string; message: string; data?: unknown }> = [];
    const captureLogger = {
      debug: (m: string, d?: unknown): void =>
        void records.push({ level: "debug", message: m, data: d }),
      info: (m: string, d?: unknown): void =>
        void records.push({ level: "info", message: m, data: d }),
      warn: (m: string, d?: unknown): void =>
        void records.push({ level: "warn", message: m, data: d }),
      error: (m: string, d?: unknown): void =>
        void records.push({ level: "error", message: m, data: d }),
    } as unknown as Parameters<
      typeof composition.tryComposeAgentRunnersBundleFromEnv
    >[0]["logger"];
    const bundle = await composition.tryComposeAgentRunnersBundleFromEnv({
      env: {
        DATABASE_URL: "postgres://test:test@localhost:65535/none",
        // MCP_BEARER_TOKEN intentionally absent
      },
      logger: captureLogger,
    });
    expect(bundle).toBeNull();
    const warn = records.find(
      (r) => r.level === "warn" && r.message === "mcp_http.unavailable",
    );
    expect(warn).toBeDefined();
  });

  it("does not abort if engine-ingestion fails to boot — logs and continues", async () => {
    // Boot-tolerant: if engine-ingestion fails (missing prod
    // composition deps in PR-M1), the operator still gets
    // engine-self-operating up. The error is logged to stderr.
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const selfOpEngine = makeFakeEngine();
    const startFactory = vi.fn(
      async () => selfOpEngine as unknown as Awaited<
        ReturnType<ServeArgs["startFactory"]>
      >,
    );
    const startIngestionFactory = vi.fn(async () => {
      throw new Error("ingestion: production WorkerContext not configured");
    });
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const serve = runServe({
      env: { DATABASE_URL: "postgres://x" },
      stdout,
      stderr,
      startFactory,
      startIngestionFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(startFactory).toHaveBeenCalledTimes(1);
    expect(startIngestionFactory).toHaveBeenCalledTimes(1);
    expect(stderr.buffer).toContain("ingestion engine did not boot");

    signalSource.emit("SIGTERM");
    await serve;

    expect(selfOpEngine.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// composeStartedEngineWithBundle — round-2 fix #3 on PR #57 (Copilot review)
// ---------------------------------------------------------------------------
//
// The helper wraps `engine-self-operating.start({...})` with bundle-cleanup
// semantics: on start() rejection, the bundle's pg.Pool is drained BEFORE
// the boot error re-throws so the process can exit without leaking
// connections; on start() success, engine.close() is wrapped to drain the
// bundle on SIGTERM.

describe("composeStartedEngineWithBundle (round-2 fix #3 on PR #57)", () => {
  it("threads bundle.runners + agentRouter into start() when bundle is present", async () => {
    const start = vi.fn(async () => ({
      close: async (): Promise<void> => undefined,
    }));
    const sentinelRouter = { __sentinel: "router" };
    const bundle = {
      runners: { __sentinel: "runners" },
      definitions: { __sentinel: "definitions" },
      router: sentinelRouter,
      close: vi.fn(async () => undefined),
    };
    const logger = { warn: vi.fn() };
    await composeStartedEngineWithBundle({
      env: { DATABASE_URL: "postgres://x" },
      bundle,
      start: start as Parameters<typeof composeStartedEngineWithBundle>[0]["start"],
      logger,
    });
    expect(start).toHaveBeenCalledTimes(1);
    const startArgs = start.mock.calls[0]?.[0] as {
      readonly agentRunners?: unknown;
      readonly agentDefinitions?: unknown;
      readonly agentRouter?: unknown;
    };
    expect(startArgs.agentRunners).toBe(bundle.runners);
    expect(startArgs.agentDefinitions).toBe(bundle.definitions);
    expect(startArgs.agentRouter).toBe(sentinelRouter);
  });

  it("omits agent fields from start() args when bundle is null (boot-tolerant)", async () => {
    const start = vi.fn(async () => ({
      close: async (): Promise<void> => undefined,
    }));
    const logger = { warn: vi.fn() };
    await composeStartedEngineWithBundle({
      env: { DATABASE_URL: "postgres://x" },
      bundle: null,
      start: start as Parameters<typeof composeStartedEngineWithBundle>[0]["start"],
      logger,
    });
    const startArgs = start.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("agentRunners" in startArgs).toBe(false);
    expect("agentDefinitions" in startArgs).toBe(false);
    expect("agentRouter" in startArgs).toBe(false);
  });

  it("CLOSES the bundle's pool when start() rejects, then re-throws the original error (round-2 fix #3)", async () => {
    const bootError = new Error("self-op start blew up");
    const start = vi.fn(async () => {
      throw bootError;
    });
    const closeSpy = vi.fn(async () => undefined);
    const bundle = {
      runners: {},
      definitions: {},
      router: {},
      close: closeSpy,
    };
    const logger = { warn: vi.fn() };
    let caught: unknown;
    try {
      await composeStartedEngineWithBundle({
        env: {},
        bundle,
        start: start as Parameters<typeof composeStartedEngineWithBundle>[0]["start"],
        logger,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(bootError);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // No close-failure warn line because closeSpy resolved cleanly.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs `agent_runners.boot_failure_close_failed` when bundle.close ALSO throws (best-effort cleanup)", async () => {
    const bootError = new Error("self-op start blew up");
    const closeError = new Error("pool already destroyed");
    const start = vi.fn(async () => {
      throw bootError;
    });
    const bundle = {
      runners: {},
      definitions: {},
      router: {},
      close: vi.fn(async () => {
        throw closeError;
      }),
    };
    const logger = { warn: vi.fn() };
    let caught: unknown;
    try {
      await composeStartedEngineWithBundle({
        env: {},
        bundle,
        start: start as Parameters<typeof composeStartedEngineWithBundle>[0]["start"],
        logger,
      });
    } catch (err) {
      caught = err;
    }
    // The ORIGINAL boot error must propagate — the close-failure
    // is a side-channel observation, not a replacement.
    expect(caught).toBe(bootError);
    expect(logger.warn).toHaveBeenCalledWith(
      "agent_runners.boot_failure_close_failed",
      expect.objectContaining({ error: closeError.message }),
    );
  });

  it("does NOT close the bundle when start() rejects with bundle === null (no-op cleanup)", async () => {
    const bootError = new Error("self-op start blew up");
    const start = vi.fn(async () => {
      throw bootError;
    });
    const logger = { warn: vi.fn() };
    let caught: unknown;
    try {
      await composeStartedEngineWithBundle({
        env: {},
        bundle: null,
        start: start as Parameters<typeof composeStartedEngineWithBundle>[0]["start"],
        logger,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(bootError);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("on start() success, wraps engine.close so the bundle drains AFTER the engine's own close", async () => {
    const order: string[] = [];
    const engineCloseSpy = vi.fn(async () => {
      order.push("engine.close");
    });
    const bundleCloseSpy = vi.fn(async () => {
      order.push("bundle.close");
    });
    const start = vi.fn(async () => ({ close: engineCloseSpy }));
    const bundle = {
      runners: {},
      definitions: {},
      router: {},
      close: bundleCloseSpy,
    };
    const logger = { warn: vi.fn() };
    const engine = await composeStartedEngineWithBundle({
      env: {},
      bundle,
      start: start as Parameters<typeof composeStartedEngineWithBundle>[0]["start"],
      logger,
    });
    await engine.close();
    expect(order).toEqual(["engine.close", "bundle.close"]);
  });
});
