/**
 * scan() with snapshotMode='periodic' tests (PR-G).
 *
 * Tests cover:
 *   1. scan() returns ScannedDocuments (snapshot rows) when snapshotMode='periodic'.
 *   2. scan() returns empty array when snapshotMode='on-event'.
 *   3. scan() returns empty array when snapshotMode='off'.
 *   4. scan() with periodic mode fetches all monitoredProjectGids.
 *   5. scan() falls back to the binding's primary projectGid when
 *      monitoredProjectGids is not configured.
 */
import { describe, it, expect, vi } from "vitest";

import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { createAsanaSourceAdapter } from "../src/index.js";
import type { AsanaClient, ProjectSnapshot } from "../src/asana-client.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedCredential(): Promise<{
  store: InstanceType<typeof InMemoryCredentialStore>;
  credentialId: CredentialId;
}> {
  const store = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId = await store.write({
    name: "asana-pat",
    schemaRef: "asanaApi/v1",
    plaintext: Buffer.from("1/asana-test-pat"),
  });
  return { store, credentialId };
}

function makeStubAsanaClient(
  snapshots: Record<string, Partial<ProjectSnapshot>> = {},
): AsanaClient {
  return {
    fetchProjectSnapshot: vi.fn(async (gid: string) => ({
      project_gid: gid,
      snapshot: [
        {
          gid: `task-in-${gid}`,
          name: "Test task",
          completed: false,
          due_on: null,
          modified_at: "2026-05-02T10:00:00.000Z",
        },
      ],
      incomplete_count: 1,
      overdue_count: 0,
      fetched_at: "2026-05-02T10:00:00.000Z",
      ...snapshots[gid],
    })),
  };
}

// ---------------------------------------------------------------------------
// 1. scan() returns snapshot rows in periodic mode
// ---------------------------------------------------------------------------

describe("scan() — snapshotMode='periodic'", () => {
  it("returns a SourceScanResult with one document per project", async () => {
    const { store, credentialId } = await seedCredential();
    const asanaClient = makeStubAsanaClient();

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-100",
        snapshotMode: "periodic",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    const result = await adapter.scan({ cursor: null });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.sourceRef).toBe("asana:project/proj-100");
    expect(result.nextCursor).toBeNull();
  });

  it("document contentBytes contains valid JSON with project_gid", async () => {
    const { store, credentialId } = await seedCredential();
    const asanaClient = makeStubAsanaClient();

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-200",
        snapshotMode: "periodic",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    const result = await adapter.scan({ cursor: null });

    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0]!;
    const payload = JSON.parse(doc.contentBytes.toString("utf8")) as {
      project_gid: string;
      snapshot: unknown[];
      incomplete_count: number;
      overdue_count: number;
      fetched_at: string;
    };
    expect(payload.project_gid).toBe("proj-200");
    expect(Array.isArray(payload.snapshot)).toBe(true);
    expect(typeof payload.incomplete_count).toBe("number");
    expect(typeof payload.overdue_count).toBe("number");
    expect(typeof payload.fetched_at).toBe("string");
  });

  it("document sourceDocId is stable for the same project", async () => {
    const { store, credentialId } = await seedCredential();
    const asanaClient = makeStubAsanaClient();

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-stable",
        snapshotMode: "periodic",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    const result1 = await adapter.scan({ cursor: null });
    const result2 = await adapter.scan({ cursor: null });

    // sourceDocId is project-stable; sourceRevision may differ per fetch
    expect(result1.documents[0]?.sourceDocId).toBe(
      result2.documents[0]?.sourceDocId,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Multiple monitoredProjectGids in periodic mode
// ---------------------------------------------------------------------------

describe("scan() — periodic mode with multiple monitored projects", () => {
  it("fetches all monitoredProjectGids and returns one document per project", async () => {
    const { store, credentialId } = await seedCredential();
    const asanaClient = makeStubAsanaClient();
    const fetchSpy = asanaClient.fetchProjectSnapshot as ReturnType<typeof vi.fn>;

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-primary",
        snapshotMode: "periodic",
        monitoredProjectGids: ["proj-a", "proj-b", "proj-c"],
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    const result = await adapter.scan({ cursor: null });

    expect(result.documents).toHaveLength(3);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenCalledWith("proj-a");
    expect(fetchSpy).toHaveBeenCalledWith("proj-b");
    expect(fetchSpy).toHaveBeenCalledWith("proj-c");
    // sourceRefs reference each project
    const refs = result.documents.map((d) => d.sourceRef);
    expect(refs).toContain("asana:project/proj-a");
    expect(refs).toContain("asana:project/proj-b");
    expect(refs).toContain("asana:project/proj-c");
  });
});

// ---------------------------------------------------------------------------
// 3. scan() is a no-op for non-periodic modes
// ---------------------------------------------------------------------------

describe("scan() — snapshotMode='on-event'", () => {
  it("returns empty documents when snapshotMode='on-event'", async () => {
    const { store, credentialId } = await seedCredential();
    const asanaClient = makeStubAsanaClient();

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-100",
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    const result = await adapter.scan({ cursor: null });
    expect(result.documents).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });
});

describe("scan() — snapshotMode='off'", () => {
  it("returns empty documents when snapshotMode='off'", async () => {
    const { store, credentialId } = await seedCredential();

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-100",
        snapshotMode: "off",
        webhookSecretCredentialId: credentialId,
      },
    });

    const result = await adapter.scan({ cursor: null });
    expect(result.documents).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. scan() without AsanaClient in periodic mode throws a clear error
// ---------------------------------------------------------------------------

describe("scan() — periodic mode without AsanaClient", () => {
  it("throws a clear error when snapshotMode='periodic' but no asanaClient provided", async () => {
    const { store, credentialId } = await seedCredential();

    // createAsanaSourceAdapter without asanaClient
    expect(() =>
      createAsanaSourceAdapter({
        credentialStore: store,
        credentialId,
        config: {
          projectGid: "proj-100",
          snapshotMode: "periodic",
          webhookSecretCredentialId: credentialId,
        },
        // No asanaClient — should throw at factory time or scan time
      }),
    ).toThrow();
  });
});
