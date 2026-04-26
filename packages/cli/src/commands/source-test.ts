/**
 * `opencoo source test <binding-id>` (PR 30 / plan #135).
 *
 * Validates a binding's config + credentials end-to-end:
 *   1. Look up the binding row in `sources_bindings`.
 *   2. Resolve the credential via the InMemoryCredentialStore
 *      (CLI doesn't run a long-lived Drizzle store, so it
 *      builds one against the same DB pool for the test).
 *   3. Resolve the adapter factory from the shared
 *      `AdapterRegistry`.
 *   4. Construct the adapter (binding-config Zod parses HERE
 *      — a misshapen config fails loud).
 *   5. v0.1 stops at construction success — production-wired
 *      `scan()` clients aren't bundled with the CLI. The
 *      operator gets `binding constructed; production scan
 *      requires the engine harness` if the slug needs a
 *      production client (drive, n8n).
 *
 * Exit codes:
 *   - 0 — adapter constructed successfully
 *   - 1 — operator error (binding not found, slug unknown)
 *   - 2 — runtime error (DB unreachable, credential decrypt
 *     failure)
 */
import pc from "picocolors";
import type { Pool } from "pg";

import {
  AdapterNotRegisteredError,
  type AdapterRegistry,
  type SourceAdapterSlug,
  SOURCE_ADAPTER_SLUGS,
} from "@opencoo/shared/adapter-registry";
import {
  DrizzleCredentialStore,
  loadEncryptionKey,
} from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import {
  exitOk,
  exitRuntimeError,
  exitUserError,
  isExitSentinel,
} from "../lib/exit.js";
import { openPool } from "../lib/db.js";

export interface SourceTestArgs {
  readonly env: Record<string, string | undefined>;
  readonly bindingId: string;
  readonly registry: AdapterRegistry;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  /** @internal Test seam — defaults to `openPool`. */
  readonly poolFactory?: (env: Record<string, string | undefined>) => Pool;
}

interface BindingRow {
  readonly id: string;
  readonly adapterSlug: string;
  readonly config: unknown;
  readonly credentialsId: string | null;
}

function isKnownSlug(s: string): s is SourceAdapterSlug {
  return (SOURCE_ADAPTER_SLUGS as readonly string[]).includes(s);
}

export async function runSourceTest(args: SourceTestArgs): Promise<void> {
  const factory = args.poolFactory ?? ((e): Pool => openPool({ env: e }));
  let pool: Pool | null = null;
  try {
    pool = factory(args.env);
    const db = drizzle(pool);
    const result = (await db.execute(sql`
      SELECT id::text AS id,
             adapter_slug,
             config,
             credentials_id::text AS credentials_id
      FROM sources_bindings
      WHERE id = ${args.bindingId}::uuid
    `)) as unknown as {
      rows: Array<{
        id: string;
        adapter_slug: string;
        config: unknown;
        credentials_id: string | null;
      }>;
    };
    const row = result.rows[0];
    if (row === undefined) {
      args.stderr.write(
        pc.red(`source test: binding ${args.bindingId} not found\n`),
      );
      return exitUserError();
    }
    const binding: BindingRow = {
      id: row.id,
      adapterSlug: row.adapter_slug,
      config: row.config,
      credentialsId: row.credentials_id,
    };
    if (!isKnownSlug(binding.adapterSlug)) {
      args.stderr.write(
        pc.red(
          `source test: unknown adapter_slug '${binding.adapterSlug}' (known: ${SOURCE_ADAPTER_SLUGS.join(", ")})\n`,
        ),
      );
      return exitUserError();
    }
    const adapterFactory = args.registry.resolve(binding.adapterSlug);
    if (adapterFactory === undefined) {
      throw new AdapterNotRegisteredError(binding.adapterSlug);
    }
    if (binding.credentialsId === null) {
      args.stderr.write(
        pc.red(`source test: binding ${binding.id} has no credentials_id set\n`),
      );
      return exitUserError();
    }
    const credentialStore = new DrizzleCredentialStore({
      db: db as unknown as ConstructorParameters<typeof DrizzleCredentialStore>[0]["db"],
      key: loadEncryptionKey(args.env as NodeJS.ProcessEnv),
      logger: new ConsoleLogger({ stream: { write: (): boolean => true } }),
    });
    try {
      adapterFactory({
        credentialStore,
        credentialId: binding.credentialsId as CredentialId,
        config: binding.config,
      });
    } catch (err) {
      args.stderr.write(
        pc.red(
          `source test: adapter construction failed: ${err instanceof Error ? err.message : String(err)}\n`,
        ),
      );
      return exitRuntimeError();
    }
    args.stdout.write(
      pc.green(
        `source test: ${binding.id} (slug=${binding.adapterSlug}) constructed ok\n`,
      ),
    );
    args.stdout.write(
      pc.dim(
        `source test: production scan requires the engine harness; CLI validates construction only in v0.1\n`,
      ),
    );
    return exitOk();
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.red(`source test: ${err instanceof Error ? err.message : String(err)}\n`),
    );
    return exitRuntimeError();
  } finally {
    if (pool !== null) {
      await pool.end().catch(() => undefined);
    }
  }
}
