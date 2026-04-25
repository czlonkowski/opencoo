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

/** Internal type for the `@fastify/static` plugin shape. The real
 *  module's runtime export is the plugin function on
 *  `mod.default`; tests inject a stub via `loadStaticPlugin` so
 *  the import-failure code path is deterministic. */
export type LoadStaticPlugin = () => Promise<unknown>;

export interface StaticUiOptions {
  /** Absolute path to the bundled SPA's dist/ directory. When
   *  undefined or missing on disk, the engine boots but the SPA
   *  fallback returns 503. */
  readonly uiDistPath?: string;
  readonly logger: Logger;
  /** @internal Test seam — defaults to dynamic
   *  `import('@fastify/static')`. A stub that throws lets tests
   *  exercise the import-failure handler deterministically
   *  (copilot #20). */
  readonly loadStaticPlugin?: LoadStaticPlugin;
}

/**
 * Resolve whether `pathName` (a static-asset path the @fastify/static
 * plugin would otherwise serve) stays within `root`. The previous
 * implementation used `path.normalize(pathName).startsWith("..")`
 * which is bypassed by absolute paths — `path.normalize("/../secret")`
 * returns `"/secret"`, not `"../secret"`, so the naive prefix check
 * passes. (copilot #20 SECURITY)
 *
 * The fix anchors the candidate against the dist root via
 * `path.resolve` then asks `path.relative` whether the resolved
 * path is reachable from inside the root WITHOUT traversal. A
 * `..`-only result (or one whose first segment is `..`) means
 * the candidate escaped; an absolute relative path means the
 * candidate is on a different drive (Windows) or otherwise
 * unrelated to the root.
 *
 * Exported for direct unit testing — the closure inside
 * `registerStaticUi` calls it.
 */
export function isPathWithinRoot(root: string, pathName: string): boolean {
  const resolvedRoot = path.resolve(root);
  // Trim leading separator(s) so `path.resolve` treats the
  // candidate as relative to the root, not as a fresh absolute
  // path. Without this, `/../secret` would resolve to `/secret`
  // (the OS root) every time.
  const relativeCandidate = pathName.replace(/^[/\\]+/, "");
  const resolvedCandidate = path.resolve(resolvedRoot, relativeCandidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  if (rel === "..") return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
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
  // statSync can race with the existsSync check above (TOCTOU)
  // — the directory could be removed between the two calls. The
  // boot-tolerant contract (Q10) requires graceful degradation,
  // so any stat failure logs + returns null rather than letting
  // the throw bubble up and crash the engine boot. (copilot #20)
  let stats;
  try {
    stats = statSync(abs);
  } catch (err) {
    logger.warn("static_ui.disabled", {
      reason: "UI_DIST_PATH stat failed (likely TOCTOU race)",
      path: abs,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
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
    const loader =
      options.loadStaticPlugin ??
      (async () => import("@fastify/static"));
    const mod = (await loader()) as { default: unknown };
    staticPlugin = mod.default;
  } catch (err) {
    options.logger.warn("static_ui.plugin_missing", {
      reason: "@fastify/static could not be loaded; SPA fallback will 503",
      error: err instanceof Error ? err.message : String(err),
    });
    // Same SPA-vs-API distinction as the boot-tolerant path
    // above (copilot #20). /api/* requests get the standard 404;
    // only SPA routes see the 503. Without this, a transient
    // plugin-load failure would mask a real 404 on the API
    // surface.
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET" || !isSpaFallbackPath(request.url)) {
        return reply
          .code(404)
          .send({ status: "not_found", path: request.url });
      }
      return reply.code(503).send({
        status: "ui_unavailable",
        reason: "static plugin unavailable",
      });
    });
    return;
  }

  await app.register(staticPlugin, {
    root: installed.uiDistPath,
    wildcard: false,
    // Defense-in-depth path-traversal guard (copilot #20).
    // @fastify/static normalises URLs upstream, but we
    // belt-and-suspenders the predicate here so any future
    // refactor that reaches this code path stays safe.
    allowedPath: (pathName) =>
      isPathWithinRoot(installed.uiDistPath, pathName),
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
