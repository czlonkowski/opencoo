/**
 * CLI's pg.Pool factory (PR 30 / plan #135).
 *
 * Every CLI verb that needs the DB constructs a Pool via this
 * helper so connection-string handling stays uniform. The
 * scaffold's `requireWithFile` honors the `DATABASE_URL_FILE`
 * Docker-secrets variant.
 */
import pg from "pg";

import { requireWithFile } from "@opencoo/shared/engine-scaffold";

export interface OpenDbOpts {
  readonly env: Record<string, string | undefined>;
}

export function openPool(opts: OpenDbOpts): pg.Pool {
  const url = requireWithFile(opts.env, "DATABASE_URL", "cli");
  return new pg.Pool({ connectionString: url, max: 4 });
}
