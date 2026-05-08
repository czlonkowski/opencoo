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

  it("returns the resolved env when every required var is set inline", () => {
    const env = {
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
      ENCRYPTION_KEY: "k",
      GITEA_URL: "http://x",
      GITEA_PAT: "p",
    };
    const resolved = assertEnv(env);
    expect(resolved).toEqual({
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
      ENCRYPTION_KEY: "k",
      GITEA_URL: "http://x",
      GITEA_PAT: "p",
    });
  });

  it("throws when one required var is missing, naming both forms", () => {
    const env = {
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
      ENCRYPTION_KEY: "k",
      GITEA_URL: "http://x",
      // GITEA_PAT missing
    };
    // Round-3 fix #1: error message names BOTH the inline and _FILE
    // names so operators with Docker-secrets deployments know which
    // knob to set.
    expect(() => assertEnv(env)).toThrow(/GITEA_PAT \(or GITEA_PAT_FILE\)/);
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

  it("honors _FILE precedence — `_FILE` variant satisfies the requirement (round-3 fix #1)", async () => {
    // Write the secret to a temp file and point the smoke at it via
    // the `_FILE` variant — same Docker-secrets convention the
    // production composition uses (production-composition.ts +
    // engine-scaffold/config.ts:53-67). The smoke MUST accept the
    // `_FILE` form; an earlier draft rejected it and would have
    // failed in every production deploy that uses Docker secrets.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-env-"));
    const file = path.join(dir, "gitea-pat");
    fs.writeFileSync(file, "secret-pat-from-file\n", { mode: 0o600 });
    try {
      const env = {
        DATABASE_URL: "postgres://x",
        REDIS_URL: "redis://x",
        ENCRYPTION_KEY: "k",
        GITEA_URL: "http://x",
        GITEA_PAT_FILE: file,
        // Note: GITEA_PAT is intentionally absent — only the _FILE
        // variant is set, mirroring a Docker-secrets deployment.
      };
      const resolved = assertEnv(env);
      expect(resolved.GITEA_PAT).toBe("secret-pat-from-file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inline value is used when both `<NAME>` and `<NAME>_FILE` are set — `_FILE` WINS", async () => {
    // readWithFile gives `_FILE` precedence; the resolved env reports
    // the file value, not the inline. Pin so a future regression that
    // flips the precedence (and silently masks rotated secrets in
    // file-mounted deployments) lands in this test, not in production.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-env-"));
    const file = path.join(dir, "gitea-pat");
    fs.writeFileSync(file, "from-file", { mode: 0o600 });
    try {
      const env = {
        DATABASE_URL: "postgres://x",
        REDIS_URL: "redis://x",
        ENCRYPTION_KEY: "k",
        GITEA_URL: "http://x",
        GITEA_PAT: "from-inline",
        GITEA_PAT_FILE: file,
      };
      const resolved = assertEnv(env);
      expect(resolved.GITEA_PAT).toBe("from-file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
  // PR-N2: INTAKE_TIMEOUT_MS is back. The receiver's direct-intake
  // branch (fired when the bound adapter exposes `enrichEvents` AND
  // the orchestrator wired `scannerClassifyQueue` — the smoke uses
  // `source-webhook` which does both) writes the intake row inline
  // before returning 200, so the practical floor is sub-second.
  // Same generous CI cap as the webhook-event poll.
  it("INTAKE_TIMEOUT_MS is at least 5s", () => {
    expect(INTAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(INTAKE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("smoke scope is webhook → intake → classify-enqueue (PR-N2 re-expansion)", () => {
  // PR-N2 re-expanded the smoke's scope. With the receiver's
  // direct-intake branch (`packages/engine-ingestion/src/intake/
  // webhook-receiver.ts`), the generic source-webhook adapter's
  // `enrichEvents` impl flips the receiver into the path that
  // INSERTs `ingestion_intake` rows inline + enqueues
  // `ingestion.scanner.classify` jobs — closing the source-webhook
  // chain that round-3 had to step around when source-webhook still
  // only had a no-op `scan()`. The smoke now polls for the intake
  // row to confirm the chain is actually live in production.
  //
  // The full chain past the intake row (compile → wiki write) still
  // depends on the rest of the production composition working; the
  // runbook §4 manual walk against an Asana binding remains the
  // canonical end-to-end verification.

  it("polls for an ingestion_intake row via awaitIntakeRow", () => {
    expect(SCRIPT_SOURCE).toMatch(/awaitIntakeRow/);
    expect(SCRIPT_SOURCE).toMatch(/FROM\s+ingestion_intake/i);
    expect(SCRIPT_SOURCE).toMatch(/INTAKE_TIMEOUT_MS/);
  });

  it("documents the expanded scope in the help text", () => {
    expect(SCRIPT_SOURCE).toMatch(/webhook.*intake.*classify/i);
    expect(SCRIPT_SOURCE).toMatch(/runbook.*§4/);
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

  // PR-Q7: the smoke MUST wrap the secret in `{ signing_secret: ... }`
  // before encrypting — that's the shape the admin-API stores and the
  // shape the receiver's per-adapter extractWebhookSecret unwraps.
  // Pre-Q7 the smoke wrote raw bytes here; that worked only because
  // the receiver also passed raw bytes through to the verifier (the
  // bug Q7 fixes). Pin the new shape so a regression doesn't bring
  // back the silent-401 mode.
  it("encrypts the JSON-wrapped {signing_secret} blob (PR-Q7)", () => {
    // Block of the form
    //   plaintext: Buffer.from(
    //     JSON.stringify({ signing_secret: webhookSecret }),
    //     "utf8",
    //   ),
    // The JSON.stringify call must be inside the plaintext: line.
    expect(SCRIPT_SOURCE).toMatch(
      /plaintext:\s*Buffer\.from\(\s*JSON\.stringify\(\s*{\s*signing_secret:/,
    );
    // And it must NOT write raw bytes (the pre-Q7 hack). The new
    // contract says: never `Buffer.from(webhookSecret, "utf8")`
    // standalone; always wrap.
    expect(SCRIPT_SOURCE).not.toMatch(
      /plaintext:\s*Buffer\.from\(\s*webhookSecret\s*,\s*["']utf8["']\s*\)/,
    );
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
