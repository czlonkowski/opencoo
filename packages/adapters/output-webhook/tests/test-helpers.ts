/**
 * Shared test helpers for the output-webhook test suite.
 *
 * Centralises the boilerplate that every test file repeats:
 *   - silent `ConsoleLogger` (so test runs stay quiet)
 *   - `InMemoryCredentialStore` wired with that logger
 *   - the canonical `VALID_PAYLOAD` fixture
 *
 * Test-only — not exported from the package's public surface.
 */
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { ConsoleLogger } from "@opencoo/shared/logger";

import type { WebhookPayload } from "../src/index.js";

export function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

export function createTestStore(): InMemoryCredentialStore {
  return new InMemoryCredentialStore({ logger: silentLogger() });
}

export const VALID_PAYLOAD: WebhookPayload = {
  event: "heartbeat.report",
  data: { summary: "All systems healthy" },
};
