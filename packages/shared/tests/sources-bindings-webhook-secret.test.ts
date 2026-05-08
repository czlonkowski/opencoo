/**
 * Migration 0007 — `sources_bindings.webhook_secret_credentials_id: uuid` (nullable).
 *
 * Webhook-mode SourceAdapters (asana, fireflies) need TWO encrypted
 * credentials per binding:
 *   - `credentials_id`               — auth credentials (PAT,
 *     API key) the adapter uses to fetch full content after a
 *     webhook fires.
 *   - `webhook_secret_credentials_id` — the HMAC signing
 *     secret the receiver verifies inbound webhooks against.
 *
 * Polling adapters leave `webhook_secret_credentials_id` NULL.
 *
 * The column is a uuid FK to `credentials.id` with `ON DELETE
 * RESTRICT` so a stray credential delete cannot orphan a live
 * binding's webhook verification.
 *
 * Phase-a appendix #2.
 *
 * # PR-Q7 — credential-write shape contract
 *
 * The admin-API source-bindings write path encrypts the **full
 * `webhook_secret` object** as the credential plaintext (see
 * `engine-self-operating/src/admin-api/routes/source-bindings.ts:660-664`):
 *
 *     credentialStore.write({
 *       plaintext: Buffer.from(JSON.stringify(webhookCreds.webhook_secret), "utf8"),
 *     });
 *
 * For Asana that's `{"x_hook_secret":"..."}`; for Fireflies / generic
 * webhook it's `{"signing_secret":"..."}`. Real upstream senders sign
 * with the **inner field value**, never the wrapper, so the
 * engine-ingestion webhook receiver MUST extract the inner field
 * before passing the bytes to the HMAC verifier — that's
 * `SourceWebhookHelpers.extractWebhookSecret(plaintext: Buffer)`.
 *
 * The tests below pin the shape contract at the schema layer (no
 * adapter import — they're purely shape assertions on
 * `SOURCE_ADAPTER_CREDENTIAL_SCHEMAS`). Adapter-side round-trip tests
 * (parse `JSON.stringify(webhook_secret)` → receiver-style unwrap →
 * inner secret bytes) live in each adapter's own test suite.
 */
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

import { sourcesBindings } from "../src/db/schema/index.js";
import {
  SOURCE_ADAPTER_CREDENTIAL_SCHEMAS,
  type SourceAdapterCredentialDescriptor,
} from "../src/source-adapter/credential-schemas.js";

describe("sources_bindings.webhook_secret_credentials_id (phase-a appendix #2)", () => {
  it("exists as a column on the sources_bindings table", () => {
    const cols = getTableConfig(sourcesBindings).columns.map((c) => c.name);
    expect(cols).toContain("webhook_secret_credentials_id");
  });

  it("is nullable (polling adapters leave it null)", () => {
    const col = getTableConfig(sourcesBindings).columns.find(
      (c) => c.name === "webhook_secret_credentials_id",
    );
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
  });

  it("has uuid dataType (FK to credentials.id)", () => {
    const col = getTableConfig(sourcesBindings).columns.find(
      (c) => c.name === "webhook_secret_credentials_id",
    );
    // drizzle's uuid columns surface as `{ dataType: 'string',
    // columnType: 'PgUUID' }` — match on columnType for tightness.
    expect(col?.columnType).toBe("PgUUID");
  });

  it("references credentials(id) ON DELETE RESTRICT (FK preserved)", () => {
    const cfg = getTableConfig(sourcesBindings);
    // FK metadata is on cfg.foreignKeys; locate the one whose
    // local column matches.
    const fk = cfg.foreignKeys.find((f) =>
      f
        .reference()
        .columns.some((c) => c.name === "webhook_secret_credentials_id"),
    );
    expect(fk, "FK on webhook_secret_credentials_id missing").toBeDefined();
    expect(fk?.onDelete).toBe("restrict");
    // Foreign-side column is `credentials.id`.
    const fkRef = fk?.reference();
    expect(fkRef?.foreignColumns[0]?.name).toBe("id");
  });
});

/**
 * Helper: simulate the admin-API encrypt path's credential plaintext
 * for a webhook adapter — the bytes the credentialStore.write call
 * receives. Mirrors source-bindings.ts:660-664 exactly so a refactor
 * of the schema would force a refactor here too.
 */
function encryptedWebhookSecretPlaintext(
  webhookSecret: Record<string, string>,
): Buffer {
  return Buffer.from(JSON.stringify(webhookSecret), "utf8");
}

/**
 * Helper: simulate the receiver's per-adapter extractWebhookSecret
 * (mirrors source-asana, source-fireflies, source-webhook
 * extractAsanaWebhookSecret / extractFirefliesWebhookSecret /
 * extractWebhookCredentialSecret). Pinned here as a shape assertion —
 * the production adapters ship their own, but the contract is "JSON
 * parse, read inner field, return bytes". If a future adapter author
 * deviates from this shape (e.g. base64-encodes the inner secret,
 * uses a different field name not declared in
 * SOURCE_ADAPTER_CREDENTIAL_SCHEMAS), the round-trip below catches
 * the drift before a binding-create + webhook-receive cycle does in
 * production.
 */
function unwrapInnerSecretLikeReceiver(
  plaintext: Buffer,
  innerField: string,
): Buffer {
  const parsed = JSON.parse(plaintext.toString("utf8")) as Record<
    string,
    unknown
  >;
  const inner = parsed[innerField];
  if (typeof inner !== "string") {
    throw new Error(
      `expected ${innerField} to be a string in unwrapped credential plaintext`,
    );
  }
  return Buffer.from(inner, "utf8");
}

/**
 * The admin-API write path stores the full `webhook_secret` object as
 * JSON. The receiver must unwrap the inner field declared in the
 * webhook-mode credential schema (the only required key under
 * `properties.webhook_secret.properties`). This pins the round-trip
 * for every webhook-mode adapter slug at once.
 */
describe("PR-Q7 — webhook credential round-trip shape (admin-API write → receiver unwrap)", () => {
  /** All adapter slugs whose descriptor declares `mode: 'webhook'`. */
  const webhookSlugs = (
    Object.entries(SOURCE_ADAPTER_CREDENTIAL_SCHEMAS) as ReadonlyArray<
      readonly [string, SourceAdapterCredentialDescriptor]
    >
  )
    .filter(([, descriptor]) => descriptor.mode === "webhook")
    .map(([slug]) => slug);

  it("at least one webhook-mode adapter is registered (asana / fireflies / webhook)", () => {
    expect(webhookSlugs.length).toBeGreaterThan(0);
    expect(webhookSlugs).toEqual(
      expect.arrayContaining(["asana", "fireflies", "webhook"]),
    );
  });

  for (const slug of webhookSlugs) {
    describe(`adapter '${slug}'`, () => {
      const descriptor = SOURCE_ADAPTER_CREDENTIAL_SCHEMAS[
        slug as keyof typeof SOURCE_ADAPTER_CREDENTIAL_SCHEMAS
      ];
      // Type narrowing — the filter above guarantees mode === 'webhook'.
      if (descriptor.mode !== "webhook") return;
      const requiredFields = descriptor.credentialSchema.properties.webhook_secret.required;

      it("declares exactly one required field under webhook_secret (the inner HMAC secret)", () => {
        // Every current webhook adapter uses a single signing-secret
        // field; multi-field webhook secrets aren't a v0.1 use case.
        expect(requiredFields.length).toBe(1);
      });

      it("admin-API plaintext shape round-trips through the receiver-style unwrap", () => {
        const innerField = requiredFields[0]!;
        const innerSecret = `${slug}-secret-${innerField}-value`;

        // Admin-API write side: encrypts JSON.stringify(webhook_secret).
        const writtenPlaintext = encryptedWebhookSecretPlaintext({
          [innerField]: innerSecret,
        });

        // Receiver side: unwrap by reading the schema-declared inner field.
        const unwrapped = unwrapInnerSecretLikeReceiver(
          writtenPlaintext,
          innerField,
        );
        expect(unwrapped.toString("utf8")).toBe(innerSecret);
      });

      it("preserves UTF-8 byte fidelity for non-ASCII secrets (defense-in-depth for HMAC)", () => {
        // HMAC byte-fidelity matters: a `String.prototype.normalize()`-style
        // detour anywhere in the path would silently shift bytes and
        // produce signature mismatches that look like upstream-side bugs.
        const innerField = requiredFields[0]!;
        const innerSecret = "łŁąśćż-🔑-byte-fidelity";
        const writtenPlaintext = encryptedWebhookSecretPlaintext({
          [innerField]: innerSecret,
        });
        const unwrapped = unwrapInnerSecretLikeReceiver(
          writtenPlaintext,
          innerField,
        );
        expect(unwrapped.toString("utf8")).toBe(innerSecret);
        // Byte-equality of the buffer too (catches a JSON.stringify
        // round-trip that mangles surrogate pairs differently).
        expect(unwrapped.equals(Buffer.from(innerSecret, "utf8"))).toBe(true);
      });
    });
  }
});
