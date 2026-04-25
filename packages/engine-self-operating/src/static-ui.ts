/**
 * Static UI middleware for engine-self-operating.
 *
 * Two responsibilities:
 *   1. Serve the bundled Management UI SPA from the directory
 *      configured via `UI_DIST_PATH`.
 *   2. SPA fallback: any request whose path has NO file extension
 *      AND is NOT under `/api/` resolves to `index.html` so React
 *      Router (or whatever the SPA uses) can take over client-
 *      side routing. (Q6 heuristic.)
 *
 * Boot-tolerant (Q10): when `UI_DIST_PATH` is undefined or its
 * directory doesn't exist, the engine STILL BOOTS. The SPA
 * fallback handler returns 503 with a clear reason; the Fastify
 * routes for the engine's other surfaces (/health, /ready, future
 * /api/...) are unaffected.
 *
 * `@fastify/static` config (Q5):
 *   - `wildcard: false` — we own the wildcard route ourselves so
 *     SPA fallback can decide between serving index.html and
 *     returning 404 for missing assets.
 *   - `allowedPath` — restricts file serving to within the dist/
 *     directory so a request with `..` segments cannot escape.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import type { FastifyInstance } from "fastify";

import type { Logger } from "@opencoo/shared/logger";

export interface StaticUiOptions {
  /** Absolute path to the bundled SPA's dist/ directory. When
   *  undefined or missing on disk, the engine boots but the SPA
   *  fallback returns 503. */
  readonly uiDistPath?: string;
  readonly logger: Logger;
}

/** Resolve whether the URL path looks like an SPA route (no file
 *  extension, not /api/). Exported for direct unit testing. */
export function isSpaFallbackPath(urlPath: string): boolean {
  // Bare `/api` AND `/api/...` both belong to the API surface;
  // serving the SPA index.html on either would surprise a
  // client probing the API root (copilot #20).
  if (urlPath === "/api" || urlPath.startsWith("/api/")) return false;
  // The pathname's last segment carries the extension (or not).
  // We check the WHOLE pathname for any `.` after the last `/` —
  // matches `*.js`, `*.css`, `*.html`, `*.png`, `*.json`, etc.
  const lastSlash = urlPath.lastIndexOf("/");
  const lastSegment = urlPath.slice(lastSlash + 1);
  return !lastSegment.includes(".");
}

interface InstalledStaticUi {
  readonly uiDistPath: string;
  readonly indexHtmlPath: string;
}

/** Verify the configured directory exists + contains an
 *  index.html. Returns null when the engine should still boot
 *  but with the SPA fallback in 503 mode. */
function verifyUiDist(
  candidate: string | undefined,
  logger: Logger,
): InstalledStaticUi | null {
  if (candidate === undefined) {
    logger.warn("static_ui.disabled", {
      reason: "UI_DIST_PATH is unset; SPA fallback will return 503",
    });
    return null;
  }
  const abs = path.resolve(candidate);
  if (!existsSync(abs)) {
    logger.warn("static_ui.disabled", {
      reason: "UI_DIST_PATH directory does not exist",
      path: abs,
    });
    return null;
  }
  const stats = statSync(abs);
  if (!stats.isDirectory()) {
    logger.warn("static_ui.disabled", {
      reason: "UI_DIST_PATH is not a directory",
      path: abs,
    });
    return null;
  }
  const indexHtmlPath = path.join(abs, "index.html");
  if (!existsSync(indexHtmlPath)) {
    logger.warn("static_ui.disabled", {
      reason: "UI_DIST_PATH directory does not contain index.html",
      path: abs,
    });
    return null;
  }
  return { uiDistPath: abs, indexHtmlPath };
}

export async function registerStaticUi(
  app: FastifyInstance,
  options: StaticUiOptions,
): Promise<void> {
  const installed = verifyUiDist(options.uiDistPath, options.logger);

  if (installed === null) {
    // Boot-tolerant fallback: any non-API GET that looks like an
    // SPA route returns 503 with the disabled reason. /api/*
    // requests are NOT intercepted — future API routes still
    // 404 normally for unknown paths.
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET" || !isSpaFallbackPath(request.url)) {
        return reply
          .code(404)
          .send({ status: "not_found", path: request.url });
      }
      return reply.code(503).send({
        status: "ui_unavailable",
        reason: "UI_DIST_PATH is not configured or its directory is missing",
      });
    });
    return;
  }

  // `@fastify/static` ships the dist/ assets; our notFoundHandler
  // owns the SPA fallback so we keep wildcard:false and decide
  // index.html-vs-404 ourselves.
  let staticPlugin;
  try {
    const mod = await import("@fastify/static");
    staticPlugin = mod.default;
  } catch (err) {
    options.logger.warn("static_ui.plugin_missing", {
      reason: "@fastify/static could not be loaded; SPA fallback will 503",
      error: err instanceof Error ? err.message : String(err),
    });
    app.setNotFoundHandler((_request, reply) =>
      reply.code(503).send({
        status: "ui_unavailable",
        reason: "static plugin unavailable",
      }),
    );
    return;
  }

  await app.register(staticPlugin, {
    root: installed.uiDistPath,
    wildcard: false,
    allowedPath: (pathName) => {
      // Reject any path that would escape the dist root.
      const normalised = path.normalize(pathName);
      return !normalised.startsWith("..");
    },
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || !isSpaFallbackPath(request.url)) {
      return reply
        .code(404)
        .send({ status: "not_found", path: request.url });
    }
    return reply
      .code(200)
      .type("text/html")
      .sendFile("index.html", installed.uiDistPath);
  });

  options.logger.info("static_ui.enabled", {
    path: installed.uiDistPath,
  });
}
