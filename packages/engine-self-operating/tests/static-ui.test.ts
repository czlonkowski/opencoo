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

import {
  isPathWithinRoot,
  isSpaFallbackPath,
  registerStaticUi,
} from "../src/static-ui.js";

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

  it("treats bare /api (no trailing slash) as NOT SPA either (copilot #20)", () => {
    // The previous predicate only looked for `/api/` so a request
    // to bare `/api` would have been served `index.html` via the
    // SPA fallback. /api is the API root by convention; serving
    // SPA HTML there is surprising and would trip up clients
    // that probe for the API surface.
    expect(isSpaFallbackPath("/api")).toBe(false);
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

  it("returns 404 for bare /api too — not the SPA index.html (copilot #20)", async () => {
    const ui = makeUiDist();
    const app = buildServer({ probes: {} });
    await registerStaticUi(app, { uiDistPath: ui, logger: silentLogger() });
    const response = await app.inject({ method: "GET", url: "/api" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("blocks path traversal — '/../secret.md' must NOT serve a file outside the dist root (copilot #20 SECURITY)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "selfop-traversal-"));
    const ui = path.join(tmpRoot, "ui");
    fs.mkdirSync(ui);
    fs.writeFileSync(path.join(ui, "index.html"), "<title>opencoo</title>");
    fs.writeFileSync(path.join(ui, "main.js"), "console.log('SPA');");
    // Sibling of `ui/` — what an attacker would try to read.
    const secretPath = path.join(tmpRoot, "secret.md");
    fs.writeFileSync(secretPath, "TOP_SECRET_TOKEN=abc123");

    const app = buildServer({ probes: {} });
    await registerStaticUi(app, { uiDistPath: ui, logger: silentLogger() });

    // The literal path `/../secret.md` would, under
    // `path.normalize('/../secret.md')`, become `/secret.md` —
    // bypassing a naive `..` startsWith check. The fix uses
    // resolved-path-within-root semantics; this test pins the
    // contract: the secret content must NOT appear in the
    // response body.
    const response = await app.inject({
      method: "GET",
      url: "/../secret.md",
    });
    expect(response.body).not.toContain("TOP_SECRET_TOKEN");
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

describe("registerStaticUi — @fastify/static import failure (copilot #20)", () => {
  // When the plugin can't load (corrupt install, missing
  // optional dependency), we still want the engine to boot AND
  // for /api/* requests to land their own 404, not a generic
  // 503 from this layer. The previous catch-all 503 handler
  // didn't distinguish.

  function makeUiDist(): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "selfop-ui-pluginfail-"));
    fs.writeFileSync(
      path.join(tmp, "index.html"),
      "<!doctype html><title>opencoo</title>",
    );
    return tmp;
  }

  it("/api/unknown returns 404 (not 503) when the static plugin fails to load", async () => {
    const ui = makeUiDist();
    const app = buildServer({ probes: {} });
    await registerStaticUi(app, {
      uiDistPath: ui,
      logger: silentLogger(),
      loadStaticPlugin: async () => {
        throw new Error("simulated plugin load failure");
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/unknown",
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("an SPA route still returns 503 when the static plugin fails to load", async () => {
    const ui = makeUiDist();
    const app = buildServer({ probes: {} });
    await registerStaticUi(app, {
      uiDistPath: ui,
      logger: silentLogger(),
      loadStaticPlugin: async () => {
        throw new Error("simulated plugin load failure");
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/dashboard",
    });
    expect(response.statusCode).toBe(503);
    const body = response.json() as { status: string };
    expect(body.status).toBe("ui_unavailable");
    await app.close();
  });
});

describe("isPathWithinRoot — defense-in-depth predicate (copilot #20)", () => {
  // Independently of @fastify/static's URL normalization, the
  // allowedPath predicate is opencoo's last line of defense
  // against path-traversal serving a file outside the dist
  // root. The previous implementation used `path.normalize` +
  // `.startsWith("..")` which is bypassed by absolute paths
  // (`/../secret` normalizes to `/secret` — no leading `..`).
  // The fix resolves against the dist root and checks the
  // relative result instead.

  it("accepts plain in-root paths", () => {
    const root = "/srv/ui";
    expect(isPathWithinRoot(root, "main.js")).toBe(true);
    expect(isPathWithinRoot(root, "/main.js")).toBe(true);
    expect(isPathWithinRoot(root, "icons/icon.png")).toBe(true);
    expect(isPathWithinRoot(root, "/index.html")).toBe(true);
  });

  it("rejects '/../secret' (the previous-impl bypass)", () => {
    const root = "/srv/ui";
    expect(isPathWithinRoot(root, "/../secret")).toBe(false);
    expect(isPathWithinRoot(root, "/../../etc/passwd")).toBe(false);
  });

  it("rejects unanchored '../' prefix", () => {
    const root = "/srv/ui";
    expect(isPathWithinRoot(root, "../secret")).toBe(false);
    expect(isPathWithinRoot(root, "../../etc/passwd")).toBe(false);
  });

  it("rejects mid-path traversal that resolves outside root", () => {
    const root = "/srv/ui";
    expect(isPathWithinRoot(root, "icons/../../secret")).toBe(false);
  });

  it("accepts mid-path traversal that resolves back inside root", () => {
    const root = "/srv/ui";
    expect(isPathWithinRoot(root, "icons/../main.js")).toBe(true);
  });
});
