import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(THIS_DIR, "..");
const SCHEMA_SRC = join(PKG_ROOT, "src");
const DRIZZLE_BIN = join(PKG_ROOT, "node_modules", ".bin", "drizzle-kit");

interface SnapshotFiles {
  readonly sql: string;
  readonly journal: string;
  readonly snapshot: string;
}

function writeStubConfig(workdir: string): string {
  const configPath = join(workdir, "drizzle.config.ts");
  const schemaGlob = join(workdir, "src", "db", "schema", "*.ts");
  const outDir = join(workdir, "drizzle");
  const body = `import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: ${JSON.stringify(schemaGlob)},
  out: ${JSON.stringify(outDir)},
  breakpoints: true,
});
`;
  writeFileSync(configPath, body);
  return configPath;
}

// Stash drizzle-kit's stdout+stderr per-workdir so collectSnapshot
// can surface them in the error message when no SQL is produced.
// Keyed by `workdir` (configPath's parent), unique per `mkdtempSync`
// call, so parallel runs don't clobber each other.
const GENERATE_OUTPUT = new Map<string, string>();

function runGenerate(configPath: string): void {
  // spawnSync (not execFileSync) so we can read stderr even on a
  // zero-exit path. drizzle-kit silently returns 0 when it loads
  // a schema and finds zero exported tables — exactly what
  // happens when the user's schema files can't resolve
  // `drizzle-orm` (their imports throw, no exports register).
  // Without capturing stderr we'd see only the opaque
  // "no .sql file produced" downstream.
  const result = spawnSync(
    DRIZZLE_BIN,
    ["generate", "--config", configPath, "--name", "init"],
    {
      cwd: join(configPath, ".."),
      env: {
        ...process.env,
        DATABASE_URL: "postgres://dummy:dummy@localhost/dummy",
      },
      encoding: "utf8",
    },
  );
  const workdir = join(configPath, "..");
  GENERATE_OUTPUT.set(
    workdir,
    `exit=${result.status}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
  );
  if (result.status !== 0) {
    throw new Error(
      `drizzle-kit generate exited ${result.status}\n${GENERATE_OUTPUT.get(workdir)}`,
    );
  }
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

interface Snapshot {
  id: string;
  prevId: string;
  [k: string]: unknown;
}

// `when` (ms-epoch) and snapshot `id` (random UUID) are nondeterministic by
// design — they exist to order migrations and reference the prev snapshot,
// not to encode schema shape. Strip them before comparing so a byte-diff
// surfaces only semantic drift in the generated artefacts.
function normalizeJournal(raw: string): Journal {
  const j = JSON.parse(raw) as Journal;
  return {
    ...j,
    entries: j.entries.map((e) => ({ ...e, when: 0 })),
  };
}

function normalizeSnapshot(raw: string): Snapshot {
  const s = JSON.parse(raw) as Snapshot;
  return { ...s, id: "NORMALIZED", prevId: "NORMALIZED" };
}

function collectSnapshot(workdir: string): SnapshotFiles {
  const drizzleDir = join(workdir, "drizzle");
  const sqlFile = readdirSync(drizzleDir).find((f) => f.endsWith(".sql"));
  if (sqlFile === undefined) {
    const captured = GENERATE_OUTPUT.get(workdir) ?? "(no captured output)";
    throw new Error(
      `no .sql file produced in ${drizzleDir}\n` +
        `drizzle-kit output:\n${captured}`,
    );
  }
  return {
    sql: readFileSync(join(drizzleDir, sqlFile), "utf8"),
    journal: JSON.stringify(
      normalizeJournal(
        readFileSync(join(drizzleDir, "meta", "_journal.json"), "utf8"),
      ),
    ),
    snapshot: JSON.stringify(
      normalizeSnapshot(
        readFileSync(join(drizzleDir, "meta", "0000_snapshot.json"), "utf8"),
      ),
    ),
  };
}

function scaffoldWorkdir(): string {
  const workdir = mkdtempSync(join(tmpdir(), "opencoo-drizzle-"));
  cpSync(SCHEMA_SRC, join(workdir, "src"), { recursive: true });
  return workdir;
}

describe("drizzle-kit generate determinism", () => {
  it("produces byte-identical artefacts across two fresh runs", () => {
    const dirA = scaffoldWorkdir();
    const dirB = scaffoldWorkdir();
    try {
      const configA = writeStubConfig(dirA);
      const configB = writeStubConfig(dirB);
      runGenerate(configA);
      runGenerate(configB);
      const a = collectSnapshot(dirA);
      const b = collectSnapshot(dirB);
      expect(a.sql).toBe(b.sql);
      expect(a.journal).toBe(b.journal);
      expect(a.snapshot).toBe(b.snapshot);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
