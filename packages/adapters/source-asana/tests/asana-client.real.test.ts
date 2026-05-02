/**
 * Real Asana API end-to-end test (PR-G).
 *
 * SKIPPED IN CI — only runs when RUN_REAL_ASANA=1 and
 * ASANA_PAT + ASANA_TEST_PROJECT_GID are set in the environment.
 *
 * NOTE: The controller does not have an Asana test account.
 * This test file exists as a framework for future manual validation.
 * It won't be exercised in this PR's CI.
 *
 * To run locally:
 *   RUN_REAL_ASANA=1 ASANA_PAT=1/xxx ASANA_TEST_PROJECT_GID=yyy \
 *     pnpm --filter @opencoo/source-asana test asana-client.real
 */
import { describe, it, expect } from "vitest";

import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { createAsanaClient } from "../src/asana-client.js";

const RUN_REAL = process.env["RUN_REAL_ASANA"] === "1";
const ASANA_PAT = process.env["ASANA_PAT"] ?? "";
const PROJECT_GID = process.env["ASANA_TEST_PROJECT_GID"] ?? "";

describe.skipIf(!RUN_REAL)("AsanaClient — real Asana API", () => {
  it("fetches a real project snapshot", async () => {
    if (!ASANA_PAT || !PROJECT_GID) {
      throw new Error(
        "RUN_REAL_ASANA=1 requires ASANA_PAT and ASANA_TEST_PROJECT_GID env vars",
      );
    }

    const store = new InMemoryCredentialStore({
      logger: new ConsoleLogger({ stream: { write: (): boolean => true } }),
    });
    const credentialId: CredentialId = await store.write({
      name: "real-asana-pat",
      schemaRef: "asanaApi/v1",
      plaintext: Buffer.from(ASANA_PAT),
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
    });

    const snapshot = await client.fetchProjectSnapshot(PROJECT_GID);

    expect(snapshot.project_gid).toBe(PROJECT_GID);
    expect(Array.isArray(snapshot.snapshot)).toBe(true);
    expect(typeof snapshot.incomplete_count).toBe("number");
    expect(typeof snapshot.overdue_count).toBe("number");
    expect(typeof snapshot.fetched_at).toBe("string");
    // Verify the shape of individual task rows
    for (const task of snapshot.snapshot) {
      expect(typeof task.gid).toBe("string");
      expect(typeof task.name).toBe("string");
      expect(typeof task.completed).toBe("boolean");
    }

    console.log(`Fetched ${snapshot.snapshot.length} tasks`);
    console.log(`Incomplete: ${snapshot.incomplete_count}`);
    console.log(`Overdue: ${snapshot.overdue_count}`);
  });
});
