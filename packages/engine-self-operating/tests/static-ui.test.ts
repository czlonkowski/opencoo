/**
 * Static UI middleware — Q4–Q6 + Q10 contract:
 *   - bundled SPA served from UI_DIST_PATH via @fastify/static
 *   - SPA fallback heuristic: no-`.`-extension + not-/api/ → index.html
 *   - file misses (`*.js`, `*.css`, `*.png`) → true 404
 *   - /api/unknown → 404
 *   - missing UI_DIST_PATH dir → engine STILL BOOTS, SPA fallback
 *     returns 503 with a clear reason (Q10 boot-tolerant).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildServer } from "@opencoo/shared/engine-scaffold";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { isSpaFallbackPath, registerStaticUi } from "../src/static-ui.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

describe("isSpaFallbackPath — Q6 heuristic", () => {
  it("treats no-extension paths as SPA routes", () => {
    expect(isSpaFallbackPath("/")).toBe(true);
    expect(isSpaFallbackPath("/dashboard")).toBe(true);
    expect(isSpaFallbackPath("/runs/abc-123")).toBe(true);
    expect(isSpaFallbackPath("/deeply/nested/route")).toBe(true);
  });

  it("treats paths with file extensions as STATIC asset requests (not SPA)", () => {
    expect(isSpaFallbackPath("/main.js")).toBe(false);
    expect(isSpaFallbackPath("/styles.css")).toBe(false);
    expect(isSpaFallbackPath("/icons/icon.png")).toBe(false);
    expect(isSpaFallbackPath("/data/payload.json")).toBe(false);
  });

  it("treats /api/* paths as NOT SPA — even if extensionless", () => {
    expect(isSpaFallbackPath("/api/")).toBe(false);
    expect(isSpaFallbackPath("/api/runs")).toBe(false);
    expect(isSpaFallbackPath("/api/runs/abc-123")).toBe(false);
  });
});

describe("registerStaticUi — boot-tolerant (Q10)", () => {
  it("missing UI_DIST_PATH → engine boots; SPA fallback returns 503", async () => {
    const app = buildServer({ probes: {} });
    await registerStaticUi(app, { logger: silentLogger() });
    const response = await app.inject({ method: "GET", url: "/dashboard" });
    expect(response.statusCode).toBe(503);
    const body = response.json() as { status: string; reason: string };
    expect(body.status).toBe("ui_unavailable");
    expect(body.reason).toMatch(/UI_DIST_PATH/);
    await app.close();
  });

  it("UI_DIST_PATH points at a non-existent dir → engine boots; SPA fallback 503", async () => {
    const app = buildServer({ probes: {} });
    await registerStaticUi(app, {
      uiDistPath: "/no/such/path/12345",
      logger: silentLogger(),
    });
    const response = await app.inject({ method: "GET", url: "/dashboard" });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("UI_DIST_PATH dir exists but lacks index.html → SPA fallback 503", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "selfop-ui-"));
    const app = buildServer({ probes: {} });
    await registerStaticUi(app, { uiDistPath: tmp, logger: silentLogger() });
    const response = await app.inject({ method: "GET", url: "/dashboard" });
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});

describe("registerStaticUi — happy path with bundled dist", () => {
  function makeUiDist(): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "selfop-ui-"));
    fs.writeFileSync(
      path.join(tmp, "index.html"),
      "<!doctype html><title>opencoo</title><div id=root></div>",
    );
    fs.writeFileSync(
      path.join(tmp, "main.js"),
      "console.log('SPA bundle');",
    );
    fs.writeFileSync(path.join(tmp, "styles.css"), "body { margin: 0 }");
    return tmp;
  }

  it("serves index.html on '/' (SPA root)", async () => {
    const ui = makeUiDist();
    const app = buildServer({ probes: {} });
    await registerStaticUi(app, { uiDistPath: ui, logger: silentLogger() });
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<title>opencoo</title>");
    await app.close();
  });

  it("serves a real *.js asset", async () => {
    const ui = makeUiDist();
    const app = buildServer({ probes: {} });
    await registerStaticUi(app, { uiDistPath: ui, logger: silentLogger() });
    const response = await app.inject({ method: "GET", url: "/main.js" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("SPA bundle");
    await app.close();
  });

  it("falls back to index.html for an extensionless path (SPA route)", async () => {
    const ui = makeUiDist();
    const app = buildServer({ probes: {} });
    await registerStaticUi(app, { uiDistPath: ui, logger: silentLogger() });
    const response = await app.inject({
      method: "GET",
      url: "/dashboard/agents",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<title>opencoo</title>");
    await app.close();
  });

  it("returns 404 for a missing *.js asset (Q6: extension → no SPA fallback)", async () => {
    const ui = makeUiDist();
    const app = buildServer({ probes: {} });
    await registerStaticUi(app, { uiDistPath: ui, logger: silentLogger() });
    const response = await app.inject({
      method: "GET",
      url: "/missing.js",
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns 404 for an unknown /api/* path (Q6: api scope → no SPA fallback)", async () => {
    const ui = makeUiDist();
    const app = buildServer({ probes: {} });
    await registerStaticUi(app, { uiDistPath: ui, logger: silentLogger() });
    const response = await app.inject({
      method: "GET",
      url: "/api/unknown",
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("/health remains 200 from the engine-scaffold buildServer routes", async () => {
    const ui = makeUiDist();
    const app = buildServer({ probes: {} });
    await registerStaticUi(app, { uiDistPath: ui, logger: silentLogger() });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
