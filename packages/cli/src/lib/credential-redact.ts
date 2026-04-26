/**
 * Credential redaction helper (PR 30 / plan #135).
 *
 * `doctor` enumerates every secret the engine needs and
 * reports presence + length WITHOUT echoing the value. This
 * helper is the SOLE sanctioned way `doctor` (and any future
 * verb) talks about secret material — the test in
 * `tests/cli.test.ts` greps for any direct stdout write of
 * a known secret value and asserts it never happens.
 *
 * For each secret name we report:
 *   - presence (`set` / `unset` / `set-via-_FILE`)
 *   - length in bytes (no value)
 *   - source (`env` / `file:<path>`) — the path is operator-
 *     visible (they set it themselves) and is NOT a secret.
 */
import fs from "node:fs";

export interface RedactedSecret {
  readonly name: string;
  readonly source: "unset" | "env" | "file";
  readonly filePath: string | null;
  readonly bytes: number;
}

/**
 * Inspect `name` (and `name + '_FILE'` per the Docker-secrets
 * convention) without revealing the value. Returns a structured
 * summary safe to log.
 */
export function inspectSecret(
  env: Record<string, string | undefined>,
  name: string,
): RedactedSecret {
  const filePath = env[`${name}_FILE`];
  if (typeof filePath === "string" && filePath.length > 0) {
    let bytes = 0;
    try {
      const stat = fs.statSync(filePath);
      bytes = stat.size;
    } catch {
      // File missing or unreadable — still report presence as
      // `file` (the operator set the var) but bytes=0 so they
      // can spot the problem.
      bytes = 0;
    }
    return { name, source: "file", filePath, bytes };
  }
  const inline = env[name];
  if (typeof inline === "string" && inline.length > 0) {
    return {
      name,
      source: "env",
      filePath: null,
      bytes: Buffer.byteLength(inline, "utf8"),
    };
  }
  return { name, source: "unset", filePath: null, bytes: 0 };
}

/** Format a `RedactedSecret` for human-readable doctor output.
 *  NEVER includes the value. */
export function formatSecret(s: RedactedSecret): string {
  if (s.source === "unset") return `${s.name}: unset`;
  if (s.source === "file") {
    return `${s.name}: file=${s.filePath ?? "?"} (${s.bytes} bytes)`;
  }
  return `${s.name}: env (${s.bytes} bytes)`;
}
