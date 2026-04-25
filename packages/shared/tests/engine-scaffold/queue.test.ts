/**
 * `buildEngineQueue` — generic BullMQ queue factory used by both
 * engine-ingestion (`prefix='ingestion'`) and engine-self-operating
 * (`prefix='selfop'`).
 */
import { describe, expect, it, vi } from "vitest";
import RedisMock from "ioredis-mock";

import { buildEngineQueue } from "../../src/engine-scaffold/index.js";

describe("buildEngineQueue", () => {
  it("constructs a queue named '<prefix>.<slug>'", () => {
    const redis = new RedisMock();
    const q = buildEngineQueue("ingestion", "scanner", {
      connection: redis as unknown as Parameters<
        typeof buildEngineQueue
      >[2]["connection"],
    });
    expect(q.name).toBe("ingestion.scanner");
  });

  it("works for the self-op prefix too", () => {
    const redis = new RedisMock();
    const q = buildEngineQueue("selfop", "heartbeat", {
      connection: redis as unknown as Parameters<
        typeof buildEngineQueue
      >[2]["connection"],
    });
    expect(q.name).toBe("selfop.heartbeat");
  });

  it("rejects empty prefix", () => {
    const redis = new RedisMock();
    expect(() =>
      buildEngineQueue("", "scanner", {
        connection: redis as unknown as Parameters<
          typeof buildEngineQueue
        >[2]["connection"],
      }),
    ).toThrow(/prefix/);
  });

  it("rejects empty slug", () => {
    const redis = new RedisMock();
    expect(() =>
      buildEngineQueue("ingestion", "", {
        connection: redis as unknown as Parameters<
          typeof buildEngineQueue
        >[2]["connection"],
      }),
    ).toThrow(/slug/);
  });

  it("rejects dotted slug — would collide with DLQ naming", () => {
    const redis = new RedisMock();
    expect(() =>
      buildEngineQueue("ingestion", "scanner.classify", {
        connection: redis as unknown as Parameters<
          typeof buildEngineQueue
        >[2]["connection"],
      }),
    ).toThrow(/'\.'/);
  });
});

void vi;
