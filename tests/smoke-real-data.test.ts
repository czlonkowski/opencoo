/**
 * Tests for `scripts/smoke-real-data.ts` (PR-M3, phase-a appendix #5).
 *
 * The smoke script is operator-grade tooling — its real test is
 * running it against a live `pnpm opencoo` stack. These unit tests
 * pin the load-bearing surface so the script's CLI shape, env-var
 * assertions, and polling primitives don't drift silently.
 *
 * What's tested here:
 *   - `parseArgs` recognises `--boot`, `--help`, `--port` plus the
 *     bare default shape.
 *   - `assertEnv` enumerates the required vars exactly (matching the
 *     production composition's REQUIRED set) and fails non-zero when
 *     any are missing.
 *   - `pollUntil` honours the timeout and returns the predicate
 *     result on success.
 *   - Constants (`HEALTH_TIMEOUT_MS`, `INTAKE_TIMEOUT_MS`,
 *     `WEBHOOK_EVENT_TIMEOUT_MS`) are pinned so a future drift surfaces
 *     in CI before it surfaces in pilot triage.
 *
 * What's NOT tested here:
 *   - The end-to-end probe against a live stack — that's the smoke's
 *     job at runtime.
 *   - HMAC signing of the webhook fixture — pinned via the script's
 *     reuse of `node:crypto`, no test logic of our own to verify.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HEALTH_TIMEOUT_MS,
  INTAKE_TIMEOUT_MS,
  REQUIRED_ENV_VARS,
  WEBHOOK_EVENT_TIMEOUT_MS,
  assertEnv,
  parseArgs,
  pollUntil,
} from "../scripts/smoke-real-data.ts";

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "smoke-real-data.ts",
);
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, "utf8");

describe("parseArgs", () => {
  it("returns defaults on empty argv", () => {
    const r = parseArgs([]);
    expect(r.boot).toBe(false);
    expect(r.help).toBe(false);
    expect(r.port).toBe(8080);
  });

  it("recognises --boot", () => {
    const r = parseArgs(["--boot"]);
    expect(r.boot).toBe(true);
  });

  it("recognises --help and -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("accepts --port=NNNN and --port NNNN", () => {
    expect(parseArgs(["--port=9090"]).port).toBe(9090);
    expect(parseArgs(["--port", "9090"]).port).toBe(9090);
  });

  it("rejects an unknown flag with a clear message", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag.*--bogus/i);
  });

  it("rejects --port with a non-numeric value", () => {
    expect(() => parseArgs(["--port=abc"])).toThrow(/--port/);
  });
});

describe("assertEnv", () => {
  it("REQUIRED_ENV_VARS matches the production composition surface", () => {
    // Pin the set so a future drift requires touching this test
    // explicitly — keeps the smoke + the production composition root
    // (packages/cli/src/provision/production-composition.ts) in
    // lockstep on what 'pilot-ready env' means.
    expect([...REQUIRED_ENV_VARS].sort()).toEqual(
      [
        "DATABASE_URL",
        "ENCRYPTION_KEY",
        "GITEA_PAT",
        "GITEA_URL",
        "REDIS_URL",
      ].sort(),
    );
  });

  it("returns the present env unchanged when every required var is set", () => {
    const env = {
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
      ENCRYPTION_KEY: "k",
      GITEA_URL: "http://x",
      GITEA_PAT: "p",
    };
    expect(() => assertEnv(env)).not.toThrow();
  });

  it("throws when one required var is missing, naming it", () => {
    const env = {
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
      ENCRYPTION_KEY: "k",
      GITEA_URL: "http://x",
      // GITEA_PAT missing
    };
    expect(() => assertEnv(env)).toThrow(/GITEA_PAT/);
  });

  it("throws when multiple required vars are missing, naming each", () => {
    const env = { DATABASE_URL: "postgres://x" };
    let caught: Error | undefined;
    try {
      assertEnv(env);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toMatch(/REDIS_URL/);
    expect(caught!.message).toMatch(/ENCRYPTION_KEY/);
    expect(caught!.message).toMatch(/GITEA_URL/);
    expect(caught!.message).toMatch(/GITEA_PAT/);
  });

  it("treats empty-string values as missing", () => {
    const env = {
      DATABASE_URL: "postgres://x",
      REDIS_URL: "",
      ENCRYPTION_KEY: "k",
      GITEA_URL: "http://x",
      GITEA_PAT: "p",
    };
    expect(() => assertEnv(env)).toThrow(/REDIS_URL/);
  });
});

describe("pollUntil", () => {
  it("returns the value when the predicate succeeds within the timeout", async () => {
    let calls = 0;
    const r = await pollUntil(
      () => {
        calls += 1;
        return calls === 3 ? "ok" : null;
      },
      { timeoutMs: 1000, intervalMs: 5 },
    );
    expect(r).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rejects with a timeout error naming the label", async () => {
    let caught: Error | undefined;
    try {
      await pollUntil(() => null, {
        timeoutMs: 30,
        intervalMs: 5,
        label: "intake row",
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toMatch(/timed out/i);
    expect(caught!.message).toMatch(/intake row/);
  });

  it("propagates a thrown error from the predicate without retrying", async () => {
    let calls = 0;
    let caught: Error | undefined;
    try {
      await pollUntil(
        () => {
          calls += 1;
          throw new Error("predicate boom");
        },
        { timeoutMs: 1000, intervalMs: 5 },
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe("predicate boom");
    expect(calls).toBe(1);
  });
});

describe("timeout constants are pinned", () => {
  // Pin these so a regression that "just bumps it 10x" lands in PR
  // review before it lands in operator confusion. Bumps are fine; the
  // edit just has to be deliberate.
  it("HEALTH_TIMEOUT_MS is 30s", () => {
    expect(HEALTH_TIMEOUT_MS).toBe(30_000);
  });
  it("WEBHOOK_EVENT_TIMEOUT_MS is at least 5s", () => {
    // Round-2 fix #8: the receiver writes the row inline before
    // returning 200, so the practical floor is 1s; CI cold-start pg
    // pools push it higher. Anything ≥ 5s and ≤ 30s is reasonable.
    expect(WEBHOOK_EVENT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(WEBHOOK_EVENT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
  it("INTAKE_TIMEOUT_MS is 60s", () => {
    expect(INTAKE_TIMEOUT_MS).toBe(60_000);
  });
});

describe("smoke script SQL shape (round-2 fix #1)", () => {
  // Source-grep pins. The smoke MUST go through `DrizzleCredentialStore`
  // for the credential row — a raw `INSERT INTO credentials` would hit
  // the schema-shape mismatch the reviewer flagged (the table has
  // {id, name, schema_ref, ciphertext bytea, iv bytea, aad bytea,
  // encryption_version}, NOT {provider, payload}) AND would store a
  // plaintext blob the receiver's `credentialStore.read()` cannot
  // decrypt. These pins make sure the regression doesn't sneak back.

  it("imports DrizzleCredentialStore from @opencoo/shared", () => {
    expect(SCRIPT_SOURCE).toMatch(
      /from\s+["']@opencoo\/shared\/credential-store["']/,
    );
    expect(SCRIPT_SOURCE).toMatch(/\bDrizzleCredentialStore\b/);
    expect(SCRIPT_SOURCE).toMatch(/\bloadEncryptionKey\b/);
  });

  it("calls credentialStore.write({ name, schemaRef, plaintext })", () => {
    // Match the Drizzle store's `write(input: CredentialInput)` shape.
    expect(SCRIPT_SOURCE).toMatch(/credentialStore\.write\(\s*{/);
    expect(SCRIPT_SOURCE).toMatch(/schemaRef:\s*["']smoke:webhook_secret["']/);
    expect(SCRIPT_SOURCE).toMatch(/plaintext:\s*Buffer\.from/);
  });

  it("does NOT raw-INSERT into the credentials table", () => {
    // The schemaless `INSERT INTO credentials (provider, payload)`
    // shape from the round-1 cut would die against the real schema.
    expect(SCRIPT_SOURCE).not.toMatch(
      /INSERT\s+INTO\s+credentials\s*\(\s*provider/i,
    );
  });

  it("queries webhook_events by binding_id (not source_id)", () => {
    // The schema column is `binding_id`; an earlier draft of the
    // runbook + smoke used the wrong name `source_id`. Pin both
    // surfaces so the regression doesn't re-emerge.
    expect(SCRIPT_SOURCE).toMatch(/FROM\s+webhook_events/i);
    expect(SCRIPT_SOURCE).toMatch(/binding_id\s*=\s*\$1/);
    expect(SCRIPT_SOURCE).not.toMatch(/source_id\s*=/i);
  });
});
