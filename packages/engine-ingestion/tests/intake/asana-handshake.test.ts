/**
 * asana-handshake.test.ts (PR-F)
 *
 * Tests the X-Hook-Secret handshake branch in the webhook receiver.
 *
 * When Asana registers a webhook it sends:
 *   POST /webhooks/:bindingId
 *   X-Hook-Secret: <random-hex>
 *   (body empty or {})
 *
 * The receiver must:
 *   1. Detect x-hook-secret header via the adapter's handshakeFn.
 *   2. Persist the secret to CredentialStore.
 *   3. UPDATE sources_bindings SET webhook_secret_credentials_id = <new id>.
 *   4. Echo X-Hook-Secret in the response header, status 200.
 *   5. NOT enqueue any scanner job.
 *   6. NOT write a webhook_events row.
 *   7. Emit a structured audit log line after the SQL UPDATE.
 *   8. Write the credential BEFORE the SQL UPDATE (security ordering).
 *
 * We use a thin mock adapter with handshakeFn rather than importing
 * @opencoo/source-asana directly (engine-ingestion doesn't depend on
 * specific adapters; the adapter boundary is DI'd at composition time).
 */
import { describe, it, expect, vi } from "vitest";

import { buildWebhookReceiver } from "../../src/intake/webhook-receiver.js";
import { InMemoryAdapterRegistry } from "../../src/intake/adapter-registry.js";
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { HmacSha256Verifier } from "@opencoo/shared/webhook-verifier";
import type { SourceAdapter } from "@opencoo/shared/source-adapter";

import { freshIntakeDbWithWebhookSecretCol } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: {
      write(): boolean {
        return true;
      },
    },
  });
}

/**
 * Build a mock adapter that exposes a handshakeFn — detecting
 * the Asana `x-hook-secret` header pattern.
 */
function buildMockAsanaAdapter(): SourceAdapter {
  return {
    slug: "asana",
    async scan() {
      return { documents: [], nextCursor: null };
    },
    webhook: {
      verifier: new HmacSha256Verifier(),
      extractSignature(headers) {
        const sig = headers["x-hook-signature"];
        return typeof sig === "string" ? sig : undefined;
      },
      handshakeFn(headers) {
        const secret = headers["x-hook-secret"];
        if (typeof secret === "string" && secret.length > 0) {
          return {
            secret,
            schemaRef: "source-asana:webhook_secret",
          };
        }
        return null;
      },
      parseEvents() {
        return [];
      },
    },
  };
}

async function makeAsanaFixture() {
  const fixture = await freshIntakeDbWithWebhookSecretCol();

  const credentialStore = new InMemoryCredentialStore({ logger: silentLogger() });

  // Seed a PAT credential for the binding (credentialsId).
  const credentialId = await credentialStore.write({
    name: "asana-pat",
    schemaRef: "source-asana:api_key",
    plaintext: Buffer.from("fake-asana-pat"),
  });

  // Wire credentials_id (PAT) but leave webhook_secret_credentials_id NULL.
  await fixture.db.execute(
    `UPDATE sources_bindings SET credentials_id = '${credentialId}', adapter_slug = 'asana' WHERE id = '${fixture.bindingId}'`,
  );

  const adapterRegistry = new InMemoryAdapterRegistry();
  adapterRegistry.register(buildMockAsanaAdapter());

  const scannerQueue = { add: vi.fn(async () => undefined) };
  const dlqQueue = { add: vi.fn(async () => undefined) };

  const app = buildWebhookReceiver({
    db: fixture.db,
    credentialStore,
    adapterRegistry,
    verifier: new HmacSha256Verifier(),
    scannerQueue: scannerQueue as unknown as Parameters<typeof buildWebhookReceiver>[0]["scannerQueue"],
    dlqQueue: dlqQueue as unknown as Parameters<typeof buildWebhookReceiver>[0]["dlqQueue"],
    logger: false,
  });

  return { ...fixture, app, credentialStore, scannerQueue, dlqQueue };
}

describe("webhook receiver — Asana X-Hook-Secret handshake (PR-F)", () => {
  it("echoes X-Hook-Secret header and returns 200", async () => {
    const { app, bindingId } = await makeAsanaFixture();
    const secret = "abc123handshakesecret";

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-hook-secret": secret,
      },
      payload: "{}",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-hook-secret"]).toBe(secret);
    await app.close();
  });

  it("persists secret and updates sources_bindings.webhook_secret_credentials_id", async () => {
    const { app, bindingId, db } = await makeAsanaFixture();
    const secret = "handshake-secret-xyz2";

    // Before handshake: webhook_secret_credentials_id is NULL.
    const before = await db.execute(
      `SELECT webhook_secret_credentials_id FROM sources_bindings WHERE id = '${bindingId}'`,
    );
    expect(
      (before.rows[0] as { webhook_secret_credentials_id: string | null })
        .webhook_secret_credentials_id,
    ).toBeNull();

    await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-hook-secret": secret,
      },
      payload: "{}",
    });

    // After handshake: should be set to a UUID.
    const after = await db.execute(
      `SELECT webhook_secret_credentials_id FROM sources_bindings WHERE id = '${bindingId}'`,
    );
    const wsCredId = (
      after.rows[0] as { webhook_secret_credentials_id: string | null }
    ).webhook_secret_credentials_id;
    expect(wsCredId).not.toBeNull();
    expect(typeof wsCredId).toBe("string");
    // Should look like a UUID.
    expect(wsCredId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    await app.close();
  });

  it("persists the secret bytes to CredentialStore so they can be read back", async () => {
    const { app, bindingId, db, credentialStore } = await makeAsanaFixture();
    const secret = "persistent-secret-abc";

    await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-hook-secret": secret,
      },
      payload: "{}",
    });

    // Read back the stored credential id.
    const after = await db.execute(
      `SELECT webhook_secret_credentials_id FROM sources_bindings WHERE id = '${bindingId}'`,
    );
    const wsCredId = (
      after.rows[0] as { webhook_secret_credentials_id: string }
    ).webhook_secret_credentials_id;

    // Verify the stored credential contains the correct secret bytes.
    const { plaintext } = await credentialStore.read(wsCredId as import("@opencoo/shared/db").CredentialId);
    expect(plaintext.toString("utf8")).toBe(secret);

    await app.close();
  });

  it("does NOT enqueue a scanner job on handshake", async () => {
    const { app, bindingId, scannerQueue } = await makeAsanaFixture();

    await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-hook-secret": "some-handshake-secret",
      },
      payload: "{}",
    });

    expect(scannerQueue.add).not.toHaveBeenCalled();
    await app.close();
  });

  it("does NOT write a webhook_events row on handshake", async () => {
    const { app, bindingId, db } = await makeAsanaFixture();

    await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-hook-secret": "some-handshake-secret",
      },
      payload: "{}",
    });

    const rows = await db.execute(`SELECT count(*) AS c FROM webhook_events`);
    expect(Number((rows.rows[0] as { c: number | string }).c)).toBe(0);
    await app.close();
  });

  it("normal event POST (no x-hook-secret) bypasses handshake branch", async () => {
    // A normal event without x-hook-secret falls through to the
    // signature-verification path. The adapter registered is the
    // mock Asana adapter which has webhook_secret_credentials_id=NULL
    // so it hits the "no credentials_id" path → 500.
    const { app, bindingId, scannerQueue } = await makeAsanaFixture();

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
      },
      payload: '{"events":[]}',
    });

    // No x-hook-secret echo in response.
    expect(res.headers["x-hook-secret"]).toBeUndefined();
    // No scanner enqueue.
    expect(scannerQueue.add).not.toHaveBeenCalled();
    await app.close();
  });

  it("adapter without handshakeFn — x-hook-secret header ignored, falls through to normal path", async () => {
    // Build a fixture with a non-Asana adapter that has no handshakeFn.
    const fixture = await freshIntakeDbWithWebhookSecretCol();
    const credentialStore = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await credentialStore.write({
      name: "drive-secret",
      schemaRef: "source-drive:webhook",
      plaintext: Buffer.from("drive-secret"),
    });
    await fixture.db.execute(
      `UPDATE sources_bindings SET credentials_id = '${credentialId}', adapter_slug = 'drive' WHERE id = '${fixture.bindingId}'`,
    );

    const adapterRegistry = new InMemoryAdapterRegistry();
    // Drive adapter stub — no webhook, no handshakeFn.
    adapterRegistry.register({ slug: "drive" });

    const scannerQueue = { add: vi.fn(async () => undefined) };
    const dlqQueue = { add: vi.fn(async () => undefined) };

    const app = buildWebhookReceiver({
      db: fixture.db,
      credentialStore,
      adapterRegistry,
      verifier: new HmacSha256Verifier(),
      scannerQueue: scannerQueue as unknown as Parameters<typeof buildWebhookReceiver>[0]["scannerQueue"],
      dlqQueue: dlqQueue as unknown as Parameters<typeof buildWebhookReceiver>[0]["dlqQueue"],
      logger: false,
    });

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${fixture.bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-hook-secret": "some-secret",
      },
      payload: '{"x":1}',
    });

    // No echo — drive adapter has no handshakeFn.
    expect(res.headers["x-hook-secret"]).toBeUndefined();
    // Falls through to signature verification → 401 (no valid sig).
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe("webhook receiver — handshake audit log (Important #2)", () => {
  it("emits webhook.handshake.received with bindingId, adapterSlug, credentialId after SQL UPDATE", async () => {
    const loggedMessages: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
    const spyLogger = {
      info(msg: string, ctx?: Record<string, unknown>): void {
        loggedMessages.push({ msg, ctx: ctx ?? {} });
      },
    };

    const { app, bindingId } = await makeAsanaFixtureWithLogger(spyLogger);

    await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-hook-secret": "audit-test-secret",
      },
      payload: "{}",
    });

    await app.close();

    const handshakeLog = loggedMessages.find(
      (m) => m.msg === "webhook.handshake.received",
    );
    expect(handshakeLog).toBeDefined();
    expect(handshakeLog!.ctx).toHaveProperty("bindingId", bindingId);
    expect(handshakeLog!.ctx).toHaveProperty("adapterSlug", "asana");
    expect(handshakeLog!.ctx).toHaveProperty("credentialId");
    // THREAT-MODEL §2 invariant 11: secret bytes must NOT be logged.
    const logStr = JSON.stringify(loggedMessages);
    expect(logStr).not.toContain("audit-test-secret");
  });
});

describe("webhook receiver — handshake write-before-update ordering (Important #3)", () => {
  it("persists the credential BEFORE the SQL UPDATE (security ordering)", async () => {
    // Security invariant: sources_bindings row must never point at a
    // non-existent credential. The CredentialStore.write() must be
    // called before the DB UPDATE that sets webhook_secret_credentials_id.
    const fixture = await freshIntakeDbWithWebhookSecretCol();
    const credentialStore = new InMemoryCredentialStore({ logger: silentLogger() });

    // Seed the PAT before installing the spy so the spy only captures
    // the handshake write (not the setup write above).
    const credentialId = await credentialStore.write({
      name: "asana-pat",
      schemaRef: "source-asana:api_key",
      plaintext: Buffer.from("fake-pat"),
    });
    await fixture.db.execute(
      `UPDATE sources_bindings SET credentials_id = '${credentialId}', adapter_slug = 'asana' WHERE id = '${fixture.bindingId}'`,
    );

    // Use a counter to capture call order.
    let callCounter = 0;
    let writeCalledAt = -1;
    let updateCalledAt = -1;

    // Spy on credentialStore.write to record when it was called.
    const originalWrite = credentialStore.write.bind(credentialStore);
    credentialStore.write = vi.fn(async (...args: Parameters<typeof credentialStore.write>) => {
      writeCalledAt = ++callCounter;
      return originalWrite(...args);
    });

    // Wrap the DB to intercept the UPDATE call on sources_bindings.
    // We wrap the `execute` raw path since the receiver uses drizzle ORM
    // update which ultimately calls execute.
    const originalExecute = (fixture.db as unknown as { execute: (...a: unknown[]) => unknown }).execute;
    const dbWithSpy = new Proxy(fixture.db, {
      get(target, prop) {
        if (prop === "update") {
          return function(this: unknown, ...args: Parameters<typeof target.update>) {
            const updateResult = target.update(...args);
            return new Proxy(updateResult, {
              get(innerTarget, innerProp) {
                if (innerProp === "set") {
                  return function(this: unknown, ...setArgs: Parameters<typeof innerTarget.set>) {
                    updateCalledAt = ++callCounter;
                    return innerTarget.set(...setArgs);
                  };
                }
                const v = innerTarget[innerProp as keyof typeof innerTarget];
                return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(innerTarget) : v;
              },
            });
          };
        }
        const val = target[prop as keyof typeof target];
        return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
      },
    });

    void originalExecute; // suppress unused warning

    const adapterRegistry = new InMemoryAdapterRegistry();
    adapterRegistry.register(buildMockAsanaAdapter());

    const app = buildWebhookReceiver({
      db: dbWithSpy as typeof fixture.db,
      credentialStore,
      adapterRegistry,
      verifier: new HmacSha256Verifier(),
      scannerQueue: { add: vi.fn(async () => undefined) } as unknown as Parameters<typeof buildWebhookReceiver>[0]["scannerQueue"],
      dlqQueue: { add: vi.fn(async () => undefined) } as unknown as Parameters<typeof buildWebhookReceiver>[0]["dlqQueue"],
      logger: false,
    });

    await app.inject({
      method: "POST",
      url: `/webhooks/${fixture.bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-hook-secret": "ordering-test-secret",
      },
      payload: "{}",
    });

    await app.close();

    // Both operations must have been observed.
    expect(writeCalledAt).toBeGreaterThan(0);
    expect(updateCalledAt).toBeGreaterThan(0);
    // CredentialStore.write must precede the DB UPDATE.
    expect(writeCalledAt).toBeLessThan(updateCalledAt);
  });
});

/**
 * Helper for audit-log tests — builds the full fixture and wires in
 * an optional appLogger.
 */
async function makeAsanaFixtureWithLogger(
  appLogger: { info(msg: string, ctx?: Record<string, unknown>): void } | undefined,
) {
  const fixture = await freshIntakeDbWithWebhookSecretCol();

  const credentialStore = new InMemoryCredentialStore({ logger: silentLogger() });

  const credentialId = await credentialStore.write({
    name: "asana-pat",
    schemaRef: "source-asana:api_key",
    plaintext: Buffer.from("fake-asana-pat"),
  });

  await fixture.db.execute(
    `UPDATE sources_bindings SET credentials_id = '${credentialId}', adapter_slug = 'asana' WHERE id = '${fixture.bindingId}'`,
  );

  const adapterRegistry = new InMemoryAdapterRegistry();
  adapterRegistry.register(buildMockAsanaAdapter());

  const scannerQueue = { add: vi.fn(async () => undefined) };
  const dlqQueue = { add: vi.fn(async () => undefined) };

  const app = buildWebhookReceiver({
    db: fixture.db,
    credentialStore,
    adapterRegistry,
    verifier: new HmacSha256Verifier(),
    scannerQueue: scannerQueue as unknown as Parameters<typeof buildWebhookReceiver>[0]["scannerQueue"],
    dlqQueue: dlqQueue as unknown as Parameters<typeof buildWebhookReceiver>[0]["dlqQueue"],
    logger: false,
    ...(appLogger !== undefined ? { appLogger } : {}),
  });

  return { ...fixture, app, credentialStore, scannerQueue, dlqQueue };
}
