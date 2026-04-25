/**
 * RedisProbe — PING against the injected ioredis client. Catches
 * connection / auth / proxy errors and returns a structured result.
 */
import type { Redis } from "ioredis";

import type { ProbeResult } from "./types.js";

/** Structural subset of `ioredis.Redis` we use — keeps the test
 *  stub small. */
export interface RedisProbeTarget {
  ping(): Promise<string>;
}

export async function redisProbe(
  redis: RedisProbeTarget | Redis,
): Promise<ProbeResult> {
  try {
    const reply = await (redis as RedisProbeTarget).ping();
    if (reply !== "PONG") {
      return {
        ok: false,
        reason: `unexpected response from PING (expected 'PONG', got ${JSON.stringify(reply)})`,
      };
    }
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}
