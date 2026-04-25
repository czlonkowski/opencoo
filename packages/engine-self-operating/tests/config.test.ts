/**
 * engine-self-operating config — extends BaseEngineConfigSchema
 * with optional uiDistPath. UI_DIST_PATH is allow-listed in the
 * no-feature-env-vars rule (PR 18 step 2).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadEngineConfig } from "../src/config.js";

describe("loadEngineConfig — happy path", () => {
  it("returns a fully-typed config when DATABASE_URL + REDIS_URL are set", () => {
    const config = loadEngineConfig({
      DATABASE_URL: "postgres://localhost/opencoo_test",
      REDIS_URL: "redis://localhost:6379",
      UI_DIST_PATH: "/srv/ui/dist",
      PORT: "9090",
      LOG_LEVEL: "debug",
      NODE_ENV: "production",
    });
    expect(config.databaseUrl).toBe("postgres://localhost/opencoo_test");
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.uiDistPath).toBe("/srv/ui/dist");
    expect(config.port).toBe(9090);
    expect(config.logLevel).toBe("debug");
    expect(config.nodeEnv).toBe("production");
  });

  it("uiDistPath is OPTIONAL — missing var still returns a valid config (Q10 boot-tolerant)", () => {
    const config = loadEngineConfig({
      DATABASE_URL: "postgres://localhost/opencoo_test",
      REDIS_URL: "redis://localhost:6379",
    });
    expect(config.uiDistPath).toBeUndefined();
  });

  it("PORT defaults to 8080 when absent", () => {
    const config = loadEngineConfig({
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
    });
    expect(config.port).toBe(8080);
  });

  it("UI_DIST_PATH_FILE wins over UI_DIST_PATH (Docker-secrets convention)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "selfop-cfg-"));
    const file = path.join(tmp, "ui-path");
    fs.writeFileSync(file, "/srv/from-file/dist");
    const config = loadEngineConfig({
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
      UI_DIST_PATH: "/srv/inline/dist",
      UI_DIST_PATH_FILE: file,
    });
    expect(config.uiDistPath).toBe("/srv/from-file/dist");
  });
});

describe("loadEngineConfig — validation failures", () => {
  it("throws when DATABASE_URL is missing — engine name in the message", () => {
    expect(() =>
      loadEngineConfig({ REDIS_URL: "redis://x" }),
    ).toThrow(/engine-self-operating config: DATABASE_URL/);
  });

  it("throws when REDIS_URL is missing", () => {
    expect(() =>
      loadEngineConfig({ DATABASE_URL: "postgres://x" }),
    ).toThrow(/engine-self-operating config: REDIS_URL/);
  });

  it("throws when PORT is non-numeric", () => {
    expect(() =>
      loadEngineConfig({
        DATABASE_URL: "postgres://x",
        REDIS_URL: "redis://x",
        PORT: "abc",
      }),
    ).toThrow();
  });

  it("throws when LOG_LEVEL is invalid", () => {
    expect(() =>
      loadEngineConfig({
        DATABASE_URL: "postgres://x",
        REDIS_URL: "redis://x",
        LOG_LEVEL: "trace",
      }),
    ).toThrow();
  });
});
