// Phase-a appendix #8 PR-P2 — Husky `post-merge` + `post-checkout`
// install + build hook. Tests the *script's* behavior contract without
// running real `pnpm install` / `pnpm build` — the hooks shell out to
// whichever `pnpm` is on PATH (or `OPENCOO_PNPM_BIN` if set), so the
// tests substitute a deterministic `fake-pnpm` shim that records its
// argv to a file. Subprocess + temp-fixture pattern matches the only
// other shell-script-style probe in the repo (`scripts/smoke-real-data.ts`)
// in spirit (probe → assert against side effects), tier-aligned with
// CONVENTIONS §3 use-case tests (in-memory only, no Docker / no net).
//
// Motivation: appendices #6 + #7 closed twice with the same merge-order
// regression — `pnpm test` on `main` after a merge cycle surfaced bugs
// each PR's CI passed in isolation; root cause was stale `dist/` and
// missing `pnpm install`. The hook automates the manual workaround.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");
const IMPL_PATH = resolve(REPO_ROOT, ".husky/_postmerge-impl.sh");

interface Fixture {
  dir: string;
  pnpmLog: string;
  fakePnpm: string;
  buildLog: string;
}

function makeFixture(opts: { failBuild?: boolean; failInstall?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "opencoo-postmerge-"));
  const pnpmLog = join(dir, "pnpm-invocations.log");
  const buildLog = join(dir, "postmerge-build.log");

  // fake-pnpm: appends each invocation's argv (one line per call) to
  // pnpmLog, then exits 0 (or 1 if simulating a failure for that verb).
  const fakeFailInstall = opts.failInstall ? "if [ \"$1\" = install ]; then echo 'simulated install failure' >&2; exit 1; fi" : "";
  const fakeFailBuild = opts.failBuild ? "if [ \"$1\" = build ]; then echo 'simulated build failure' >&2; exit 1; fi" : "";
  const fakeBody = [
    "#!/bin/sh",
    `echo "$@" >> '${pnpmLog}'`,
    fakeFailInstall,
    fakeFailBuild,
    "exit 0",
    "",
  ].join("\n");
  const fakePnpm = join(dir, "fake-pnpm");
  writeFileSync(fakePnpm, fakeBody);
  chmodSync(fakePnpm, 0o755);

  return { dir, pnpmLog, fakePnpm, buildLog };
}

function readLog(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

interface InvokeOpts {
  fixture: Fixture;
  /** Initial env exported to the impl. Test owns ORIG_HEAD / HEAD / changed-files semantics
   *  via the OPENCOO_POSTMERGE_TEST_CHANGED_FILES override the impl reads when set. */
  changedFiles?: string;
  origHead?: string | null;
  husky?: string;
  gitNoVerify?: string;
  /** Path to write the build log to — overrides /tmp default for test isolation. */
  buildLogPath?: string;
}

function invokeImpl(opts: InvokeOpts): { stdout: string; stderr: string; status: number | null } {
  const { fixture, changedFiles, origHead, husky, gitNoVerify, buildLogPath } = opts;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fixture.dir}:${process.env.PATH ?? ""}`,
    OPENCOO_PNPM_BIN: fixture.fakePnpm,
    OPENCOO_POSTMERGE_BUILD_LOG: buildLogPath ?? fixture.buildLog,
  };
  if (changedFiles !== undefined) {
    env.OPENCOO_POSTMERGE_TEST_CHANGED_FILES = changedFiles;
  }
  if (origHead === null) {
    delete env.ORIG_HEAD;
  } else if (origHead !== undefined) {
    env.ORIG_HEAD = origHead;
  }
  if (husky !== undefined) env.HUSKY = husky;
  if (gitNoVerify !== undefined) env.GIT_NO_VERIFY = gitNoVerify;

  const result = spawnSync("/bin/sh", [IMPL_PATH], {
    env,
    encoding: "utf8",
    cwd: fixture.dir,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

describe("post-merge install + build hook", () => {
  let fixtures: Fixture[] = [];

  beforeEach(() => {
    fixtures = [];
  });

  afterEach(() => {
    for (const f of fixtures) {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  function track(f: Fixture): Fixture {
    fixtures.push(f);
    return f;
  }

  test("impl script exists and is sourceable", () => {
    expect(existsSync(IMPL_PATH)).toBe(true);
  });

  test("GIT_NO_VERIFY=1 → exits 0 + skips install + build", () => {
    const f = track(makeFixture());
    const result = invokeImpl({
      fixture: f,
      gitNoVerify: "1",
      origHead: "abc123",
      changedFiles: "pnpm-lock.yaml",
    });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/skipping/i);
    expect(readLog(f.pnpmLog)).toEqual([]);
  });

  test("HUSKY=0 → exits 0 + skips install + build", () => {
    const f = track(makeFixture());
    const result = invokeImpl({
      fixture: f,
      husky: "0",
      origHead: "abc123",
      changedFiles: "pnpm-lock.yaml",
    });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/skipping/i);
    expect(readLog(f.pnpmLog)).toEqual([]);
  });

  test("no ORIG_HEAD (initial-clone case) → exits 0 + skips install + build", () => {
    const f = track(makeFixture());
    const result = invokeImpl({
      fixture: f,
      origHead: null,
      changedFiles: "pnpm-lock.yaml",
    });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/no ORIG_HEAD|no merge ref/i);
    expect(readLog(f.pnpmLog)).toEqual([]);
  });

  test("lockfile changed → invokes pnpm install + pnpm build", () => {
    const f = track(makeFixture());
    const result = invokeImpl({
      fixture: f,
      origHead: "abc123",
      changedFiles: "pnpm-lock.yaml",
    });
    expect(result.status).toBe(0);
    const calls = readLog(f.pnpmLog);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => c.startsWith("install"))).toBe(true);
    expect(calls.some((c) => c.startsWith("build"))).toBe(true);
    expect(result.stdout + result.stderr).toMatch(/install \+ build complete/i);
  });

  test("package.json changed → invokes pnpm install + pnpm build", () => {
    const f = track(makeFixture());
    const result = invokeImpl({
      fixture: f,
      origHead: "abc123",
      changedFiles: "packages/shared/package.json",
    });
    expect(result.status).toBe(0);
    const calls = readLog(f.pnpmLog);
    expect(calls.some((c) => c.startsWith("install"))).toBe(true);
    expect(calls.some((c) => c.startsWith("build"))).toBe(true);
  });

  test("nothing changed → skips install but still runs build", () => {
    // Stale-dist regression class: even when no lockfile changes, prior
    // merges have surfaced bugs from stale `dist/` (appendix #6 + #7
    // closes). Always rebuilding is the cheap belt-and-suspenders fix.
    const f = track(makeFixture());
    const result = invokeImpl({
      fixture: f,
      origHead: "abc123",
      changedFiles: "",
    });
    expect(result.status).toBe(0);
    const calls = readLog(f.pnpmLog);
    expect(calls.some((c) => c.startsWith("install"))).toBe(false);
    expect(calls.some((c) => c.startsWith("build"))).toBe(true);
  });

  test("pnpm install failure → exits non-zero + surfaces error", () => {
    const f = track(makeFixture({ failInstall: true }));
    const result = invokeImpl({
      fixture: f,
      origHead: "abc123",
      changedFiles: "pnpm-lock.yaml",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/pnpm install FAILED/);
    // build must not run after a failed install
    const calls = readLog(f.pnpmLog);
    expect(calls.some((c) => c.startsWith("build"))).toBe(false);
  });

  test("pnpm build failure → exits non-zero + dumps log", () => {
    const f = track(makeFixture({ failBuild: true }));
    const buildLogPath = join(f.dir, "build.log");
    const result = invokeImpl({
      fixture: f,
      origHead: "abc123",
      changedFiles: "",
      buildLogPath,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/pnpm build FAILED/);
    expect(result.stdout + result.stderr).toMatch(/simulated build failure/);
    // Build log file should exist (impl tee'd output through it)
    expect(existsSync(buildLogPath)).toBe(true);
  });

  test("post-checkout file-checkout flag (0) → no-op", () => {
    // post-checkout receives $1=prev $2=new $3=flag. Flag=0 is a
    // single-file checkout (e.g. `git checkout -- foo`), not a branch
    // switch. The wrapper must short-circuit; we test the wrapper
    // directly by setting OPENCOO_POSTMERGE_CHECKOUT_FLAG=0 — the impl
    // honours it the same way as a missing ORIG_HEAD.
    const f = track(makeFixture());
    const checkoutWrapper = resolve(REPO_ROOT, ".husky/post-checkout");
    if (!existsSync(checkoutWrapper)) {
      // Wrapper file existence is asserted by a sibling test; if it's
      // missing this test will fail loudly elsewhere.
      throw new Error(`expected ${checkoutWrapper} to exist`);
    }
    const result = spawnSync("/bin/sh", [checkoutWrapper, "abc123", "def456", "0"], {
      env: {
        ...process.env,
        PATH: `${f.dir}:${process.env.PATH ?? ""}`,
        OPENCOO_PNPM_BIN: f.fakePnpm,
      },
      encoding: "utf8",
      cwd: f.dir,
    });
    expect(result.status).toBe(0);
    expect(readLog(f.pnpmLog)).toEqual([]);
  });

  test("post-merge wrapper file exists + invokes the impl", () => {
    // The wrapper must exist + delegate to the impl. We don't run the
    // wrapper end-to-end (it depends on a real git repo for ORIG_HEAD
    // / `git diff`); that's covered by the impl-level tests above.
    // This test pins the wrapper exists + sources the impl.
    const wrapper = resolve(REPO_ROOT, ".husky/post-merge");
    expect(existsSync(wrapper)).toBe(true);
    const body = readFileSync(wrapper, "utf8");
    expect(body).toMatch(/_postmerge-impl\.sh/);
  });

  test("post-checkout wrapper file exists + invokes the impl", () => {
    const wrapper = resolve(REPO_ROOT, ".husky/post-checkout");
    expect(existsSync(wrapper)).toBe(true);
    const body = readFileSync(wrapper, "utf8");
    expect(body).toMatch(/_postmerge-impl\.sh/);
  });
});
