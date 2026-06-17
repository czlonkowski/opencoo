#!/usr/bin/env node
/**
 * `opencoo` bin entry (PR 30 / plan #135).
 *
 * Wires the per-command runners to the production adapter
 * registry (so `source test` resolves the right factory) and
 * threads `process.argv` + `process.env` + `process.cwd()`
 * into `parseAndDispatch`.
 *
 * The version string is sourced from this package's
 * package.json — at runtime we read it via a static import of
 * the JSON file (bundlers + Node 22 ESM both support
 * `with: { type: "json" }` import attributes).
 */
import { createRequire } from "node:module";

import {
  buildAdapterRegistry,
  type SourceAdapterFactory,
} from "@opencoo/shared/adapter-registry";

import { runSourceTest } from "./commands/source-test.js";
import { parseAndDispatch } from "./parse.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };
const VERSION = typeof pkg.version === "string" ? pkg.version : "0.0.0";

/** Build the production adapter registry. Each adapter
 *  package exports its own `create*Adapter` factory; we dynamic-
 *  import them so the CLI doesn't pay the import cost for an
 *  adapter slug it never tests.
 *
 *  The factories adapt each adapter's specific extras shape
 *  (e.g. drive's `makeDrive`) into the shared
 *  `AdapterFactoryArgs` shape. v0.1 throws on the
 *  production-client requirement for drive + n8n — the CLI
 *  validates construction only (decision Q12 docs). */
async function loadProductionFactory(
  slug: "drive" | "asana" | "n8n" | "fireflies" | "webhook" | "okf",
): Promise<SourceAdapterFactory> {
  switch (slug) {
    case "drive": {
      const mod = await import("@opencoo/source-drive");
      return (a) =>
        mod.createGoogleDriveAdapter({
          credentialStore: a.credentialStore,
          credentialId: a.credentialId,
          config: a.config,
          makeDrive: () => {
            throw new Error(
              "drive: production makeDrive not wired in v0.1 CLI; binding-config validation only",
            );
          },
        });
    }
    case "asana": {
      const mod = await import("@opencoo/source-asana");
      return (a) =>
        mod.createAsanaSourceAdapter({
          credentialStore: a.credentialStore,
          credentialId: a.credentialId,
          config: a.config,
        });
    }
    case "n8n": {
      const mod = await import("@opencoo/source-n8n");
      return (a) =>
        mod.createN8nSourceAdapter({
          credentialStore: a.credentialStore,
          credentialId: a.credentialId,
          config: a.config,
          makeApi: () => {
            throw new Error(
              "n8n: production makeApi not wired in v0.1 CLI; binding-config validation only",
            );
          },
        });
    }
    case "fireflies": {
      const mod = await import("@opencoo/source-fireflies");
      return (a) =>
        mod.createFirefliesSourceAdapter({
          credentialStore: a.credentialStore,
          credentialId: a.credentialId,
          config: a.config,
        });
    }
    case "webhook": {
      const mod = await import("@opencoo/source-webhook");
      return (a) =>
        mod.createSourceWebhookAdapter({
          credentialStore: a.credentialStore,
          credentialId: a.credentialId,
          config: a.config,
        });
    }
    case "okf": {
      // OKF reads a local bundle directory — no makeApi/makeDrive to
      // wire, so this factory is fully operational under `source test`.
      const mod = await import("@opencoo/source-okf");
      return (a) =>
        mod.createOkfSourceAdapter({
          credentialStore: a.credentialStore,
          credentialId: a.credentialId,
          config: a.config,
        });
    }
  }
}

async function buildProductionRegistry(): Promise<
  ReturnType<typeof buildAdapterRegistry>
> {
  const slugs = [
    "drive",
    "asana",
    "n8n",
    "fireflies",
    "webhook",
    "okf",
  ] as const;
  const factories: Partial<
    Record<(typeof slugs)[number], SourceAdapterFactory>
  > = {};
  for (const s of slugs) {
    factories[s] = await loadProductionFactory(s);
  }
  return buildAdapterRegistry({ factories });
}

async function main(): Promise<void> {
  try {
    await parseAndDispatch({
      argv: process.argv.slice(2),
      env: process.env,
      cwd: process.cwd(),
      version: VERSION,
      stdout: process.stdout,
      stderr: process.stderr,
      runners: {
        // Inject the production registry so `source test` works.
        // Other commands use their default runners — they don't
        // need the registry.
        sourceTest: async (a) => {
          const registry = await buildProductionRegistry();
          await runSourceTest({ ...a, registry });
        },
      },
    });
  } catch (error) {
    // commander throws CommanderError objects (with code prefix
    // `commander.`) on parse failure when `.exitOverride()` is
    // set. Render a clean message + exit 1 instead of letting
    // the unhandled rejection surface a stack trace.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string" &&
      ((error as { code: string }).code).startsWith("commander.") &&
      "message" in error &&
      typeof (error as { message: unknown }).message === "string"
    ) {
      process.stderr.write(`${(error as { message: string }).message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

void main();
