/**
 * source-okf adapter tests (PR-OKF3b).
 *
 * Three layers:
 *   1. The shared `sourceAdapterContract` (polling mode) against a
 *      temp-dir-backed OKF bundle. `seed`/`simulate` are file writes,
 *      edits, and deletes; the adapter's revision-map cursor drives
 *      change detection so all 9 polling assertions hold.
 *   2. Adapter-specific behaviour: slug, concept-id derivation,
 *      reserved-file skipping (`index.md`/`log.md` at any depth),
 *      verbatim (lossless) content bytes, sha256 revisions, the
 *      JSON revision-map cursor shape, `subdir` scoping, and the
 *      no-secret credential contract.
 *   3. Real-data: pointed at Google's vendored OKF reference bundles
 *      (`crypto_bitcoin`, `ga4`) the adapter surfaces exactly the
 *      non-reserved concepts, byte-for-byte.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { sourceAdapterContract } from "@opencoo/shared/adapter-contract-tests";
import {
  InMemoryCredentialStore,
  type CredentialStore,
} from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  OKF_ADAPTER_SLUG,
  createOkfSourceAdapter,
} from "../src/index.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedEmptyCredential(
  store: CredentialStore,
): Promise<CredentialId> {
  return store.write({
    name: "okf-test",
    schemaRef: "okf-source/v1",
    plaintext: Buffer.from(""),
  });
}

const OKF_DOC = `---
type: BigQuery Table
title: Orders
description: One row per completed order.
tags: [sales, orders]
timestamp: '2026-05-28T00:00:00Z'
---

# Schema

| col | type |
| --- | --- |
| id  | STRING |

See [customers](/tables/customers.md).
`;

// ---------------------------------------------------------------------------
// Shared sourceAdapterContract — polling (temp-dir bundle)
// ---------------------------------------------------------------------------

sourceAdapterContract({
  backendName: "source-okf",
  mode: "polling",
  makeAdapter: async () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-contract-"));
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedEmptyCredential(store);
    const adapter = createOkfSourceAdapter({
      credentialStore: store,
      credentialId,
      config: { bundlePath: dir, contentKind: "okf-bundle" },
    });
    const fileFor = (docId: string): string => join(dir, `${docId}.md`);
    const write = (docId: string, bytes: Buffer): void => {
      const p = fileFor(docId);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, bytes);
    };
    return {
      adapter,
      seed: (initial) => {
        for (const d of initial) write(d.sourceDocId, d.contentBytes);
      },
      simulate: {
        addDoc: (d) => write(d.sourceDocId, d.contentBytes),
        bumpRevision: (docId, _rev, bytes) => write(docId, bytes),
        removeDoc: (docId) => rmSync(fileFor(docId), { force: true }),
      },
      cleanup: async () => {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Adapter-specific behaviour
// ---------------------------------------------------------------------------

describe("source-okf — adapter", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeBundle(files: Readonly<Record<string, string>>): string {
    const dir = mkdtempSync(join(tmpdir(), "okf-bundle-"));
    tempDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, "utf8");
    }
    return dir;
  }

  async function adapterFor(
    bundlePath: string,
    extra: { subdir?: string } = {},
  ): Promise<ReturnType<typeof createOkfSourceAdapter>> {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedEmptyCredential(store);
    return createOkfSourceAdapter({
      credentialStore: store,
      credentialId,
      config: { bundlePath, ...extra },
    });
  }

  it("slug is 'okf'", async () => {
    const adapter = await adapterFor(makeBundle({ "a.md": OKF_DOC }));
    expect(adapter.slug).toBe(OKF_ADAPTER_SLUG);
    expect(adapter.slug).toBe("okf");
  });

  it("emits one document per concept; sourceDocId and sourceRef are the bundle-relative path minus .md", async () => {
    const dir = makeBundle({
      "tables/orders.md": OKF_DOC,
      "datasets/sales.md": OKF_DOC,
    });
    const adapter = await adapterFor(dir);
    const result = await adapter.scan({ cursor: null });
    const ids = result.documents.map((d) => d.sourceDocId).sort();
    expect(ids).toEqual(["datasets/sales", "tables/orders"]);
    for (const d of result.documents) {
      // sourceRef is the bare concept id — the compiler uses it
      // directly as the page path (no prefix).
      expect(d.sourceRef).toBe(d.sourceDocId);
    }
  });

  it("skips the reserved index.md and log.md at every depth", async () => {
    const dir = makeBundle({
      "index.md": "# root index\n",
      "log.md": "## 2026-01-01\n- seeded\n",
      "tables/index.md": "# tables\n",
      "tables/log.md": "## 2026-01-01\n",
      "tables/orders.md": OKF_DOC,
    });
    const adapter = await adapterFor(dir);
    const result = await adapter.scan({ cursor: null });
    expect(result.documents.map((d) => d.sourceDocId)).toEqual(["tables/orders"]);
  });

  it("ignores non-markdown files", async () => {
    const dir = makeBundle({
      "tables/orders.md": OKF_DOC,
      "tables/notes.txt": "not a concept",
      "README": "no extension",
    });
    const adapter = await adapterFor(dir);
    const result = await adapter.scan({ cursor: null });
    expect(result.documents.map((d) => d.sourceDocId)).toEqual(["tables/orders"]);
  });

  it("emits contentBytes verbatim (lossless read)", async () => {
    const dir = makeBundle({ "tables/orders.md": OKF_DOC });
    const adapter = await adapterFor(dir);
    const result = await adapter.scan({ cursor: null });
    const doc = result.documents[0];
    expect(doc).toBeDefined();
    expect(doc!.contentBytes.equals(Buffer.from(OKF_DOC, "utf8"))).toBe(true);
  });

  it("derives sourceRevision as a 16-hex sha256 prefix", async () => {
    const dir = makeBundle({ "a.md": OKF_DOC });
    const adapter = await adapterFor(dir);
    const result = await adapter.scan({ cursor: null });
    expect(result.documents[0]?.sourceRevision).toMatch(/^[0-9a-f]{16}$/);
  });

  it("nextCursor is a JSON revision-map keyed by concept id", async () => {
    const dir = makeBundle({
      "tables/orders.md": OKF_DOC,
      "datasets/sales.md": OKF_DOC,
    });
    const adapter = await adapterFor(dir);
    const result = await adapter.scan({ cursor: null });
    expect(result.nextCursor).not.toBeNull();
    const map = JSON.parse(result.nextCursor as string) as Record<string, string>;
    expect(Object.keys(map).sort()).toEqual(["datasets/sales", "tables/orders"]);
    for (const rev of Object.values(map)) expect(rev).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a malformed cursor is tolerated as a full re-scan", async () => {
    const dir = makeBundle({ "a.md": OKF_DOC });
    const adapter = await adapterFor(dir);
    const result = await adapter.scan({ cursor: "not-json{" });
    expect(result.documents.map((d) => d.sourceDocId)).toEqual(["a"]);
  });

  it("scopes the walk to `subdir` and makes concept ids relative to it", async () => {
    const dir = makeBundle({
      "datasets/a.md": OKF_DOC,
      "datasets/nested/b.md": OKF_DOC,
      "tables/c.md": OKF_DOC,
    });
    const adapter = await adapterFor(dir, { subdir: "datasets" });
    const result = await adapter.scan({ cursor: null });
    expect(result.documents.map((d) => d.sourceDocId).sort()).toEqual([
      "a",
      "nested/b",
    ]);
  });

  it("does not read the credential — a local OKF bundle has no secret", async () => {
    // A bundle adapter constructed with a credentialId that was never
    // written still scans cleanly: the adapter never resolves it (the
    // credential arg is reserved for a future git-clone transport).
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const bogusId = "11111111-1111-1111-1111-111111111111" as unknown as CredentialId;
    const adapter = createOkfSourceAdapter({
      credentialStore: store,
      credentialId: bogusId,
      config: { bundlePath: makeBundle({ "a.md": OKF_DOC }) },
    });
    const result = await adapter.scan({ cursor: null });
    expect(result.documents.map((d) => d.sourceDocId)).toEqual(["a"]);
  });

  it("rejects a subdir that escapes the bundle root (path traversal)", async () => {
    const dir = makeBundle({ "datasets/a.md": OKF_DOC });
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedEmptyCredential(store);
    // A `..` subdir would let join(bundlePath, subdir) escape and read
    // arbitrary local files — rejected at factory construction, before
    // scan() ever walks anything.
    expect(() =>
      createOkfSourceAdapter({
        credentialStore: store,
        credentialId,
        config: { bundlePath: dir, subdir: "../../../etc" },
      }),
    ).toThrow();
  });

  it("does not follow symlinks — a malicious bundle cannot exfiltrate host files", async () => {
    // A symlink Dirent reports neither isFile nor isDirectory, so the
    // walk skips it. This keeps reads inside the bundle root: a bundle
    // shipping `evil.md -> /etc/passwd` cannot leak that file into the
    // wiki.
    const outside = mkdtempSync(join(tmpdir(), "okf-outside-"));
    tempDirs.push(outside);
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "---\ntype: Secret\n---\n\nhost file\n", "utf8");

    const dir = makeBundle({ "tables/orders.md": OKF_DOC });
    symlinkSync(secret, join(dir, "evil.md"));

    const adapter = await adapterFor(dir);
    const result = await adapter.scan({ cursor: null });
    expect(result.documents.map((d) => d.sourceDocId)).toEqual(["tables/orders"]);
  });

  it("invalid binding config (missing bundlePath) throws at factory time", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedEmptyCredential(store);
    expect(() =>
      createOkfSourceAdapter({
        credentialStore: store,
        credentialId,
        config: {},
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Real-data — Google's vendored OKF reference bundles
// ---------------------------------------------------------------------------

describe("source-okf — Google OKF reference bundles", () => {
  const FIXTURE_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../shared/tests/page-spec/__fixtures__/okf",
  );

  async function adapterForFixture(
    bundle: string,
  ): Promise<ReturnType<typeof createOkfSourceAdapter>> {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await store.write({
      name: "okf-fixture",
      schemaRef: "okf-source/v1",
      plaintext: Buffer.from(""),
    });
    return createOkfSourceAdapter({
      credentialStore: store,
      credentialId,
      config: { bundlePath: join(FIXTURE_ROOT, bundle) },
    });
  }

  it("the vendored fixtures are present", () => {
    expect(existsSync(join(FIXTURE_ROOT, "crypto_bitcoin"))).toBe(true);
    expect(existsSync(join(FIXTURE_ROOT, "ga4"))).toBe(true);
  });

  it("crypto_bitcoin surfaces exactly the five non-reserved concepts", async () => {
    const adapter = await adapterForFixture("crypto_bitcoin");
    const result = await adapter.scan({ cursor: null });
    expect(result.documents.map((d) => d.sourceDocId).sort()).toEqual([
      "datasets/crypto_bitcoin",
      "tables/blocks",
      "tables/inputs",
      "tables/outputs",
      "tables/transactions",
    ]);
  });

  it("ga4 surfaces its single dataset concept", async () => {
    const adapter = await adapterForFixture("ga4");
    const result = await adapter.scan({ cursor: null });
    expect(result.documents.map((d) => d.sourceDocId)).toEqual([
      "datasets/ga4_obfuscated_sample_ecommerce",
    ]);
  });

  it("emits each concept's bytes byte-for-byte (lossless round-trip read)", async () => {
    const adapter = await adapterForFixture("crypto_bitcoin");
    const result = await adapter.scan({ cursor: null });
    const blocks = result.documents.find(
      (d) => d.sourceDocId === "tables/blocks",
    );
    expect(blocks).toBeDefined();
    const onDisk = readFileSync(
      join(FIXTURE_ROOT, "crypto_bitcoin", "tables", "blocks.md"),
    );
    expect(blocks!.contentBytes.equals(onDisk)).toBe(true);
  });
});
