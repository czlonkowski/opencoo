/**
 * PostgresProbe — `SELECT 1` against the injected pool. Used by
 * the /ready endpoint to gate traffic via the reverse proxy.
 *
 * Per Correction A from team-lead, the test seam is the pool's
 * `query` method (mocked with `vi.fn` in tests, real `pg.Pool` in
 * prod). Avoiding pglite here keeps the probe path dependency-free.
 */
import type { Pool } from "pg";

import type { ProbeResult } from "./types.js";

/**
 * Subset of `pg.Pool` we actually use. Letting the parameter type
 * be a structural minimum keeps the test mock simple — vi.fn
 * doesn't need to satisfy the full Pool surface.
 */
export interface PostgresProbeTarget {
  query(text: string): Promise<unknown>;
}

export async function postgresProbe(
  pool: PostgresProbeTarget | Pool,
): Promise<ProbeResult> {
  try {
    await (pool as PostgresProbeTarget).query("SELECT 1");
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}
