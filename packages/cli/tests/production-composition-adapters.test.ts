/**
 * Production-composition SourceAdapter coverage (PR-OKF3b regression).
 *
 * Bug this pins: `loadSourceAdapterFactories` (production-composition.ts)
 * is the PRODUCTION composition root — the scanner resolves every
 * binding's adapter through the map it returns. The map is typed
 * `Record<string, …>`, so adding a slug to `SOURCE_ADAPTER_SLUGS`
 * WITHOUT registering it here is NOT a typecheck error: the binding
 * silently no-ops in production (`scanner.adapter_missing` + skip),
 * even though the CLI `source test` path and all unit/contract tests
 * stay green. PR-OKF3b shipped `okf` to every shared registry + the
 * CLI but originally missed this map; this test fails loudly if any
 * future slug addition repeats that mistake.
 */
import { describe, expect, it } from "vitest";

import { SOURCE_ADAPTER_SLUGS } from "@opencoo/shared/adapter-registry";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { loadSourceAdapterFactories } from "../src/provision/production-composition.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

describe("production composition — SourceAdapter factory coverage", () => {
  it("registers a production factory for EVERY slug in SOURCE_ADAPTER_SLUGS", async () => {
    const factories = await loadSourceAdapterFactories(silentLogger());
    for (const slug of SOURCE_ADAPTER_SLUGS) {
      expect(
        typeof factories[slug],
        `production-composition.loadSourceAdapterFactories is missing a factory for '${slug}' — its bindings will silently no-op in production`,
      ).toBe("function");
    }
  });

  it("registers the okf factory (PR-OKF3b)", async () => {
    const factories = await loadSourceAdapterFactories(silentLogger());
    expect(typeof factories["okf"]).toBe("function");
  });
});
