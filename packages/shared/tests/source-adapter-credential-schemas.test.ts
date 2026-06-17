/**
 * Source-adapter credential schemas registry test.
 *
 * The Management UI's "+ New binding" modal needs to know, for
 * each of the four wired SourceAdapters, the JSON-Schema-shaped
 * credential descriptor it should render. Hardcoding adapter
 * forms in the UI defeats CLAUDE.md's "the management UI renders
 * the config form dynamically from the schema". The registry
 * lives in @opencoo/shared so the server validator and the UI
 * share the same source of truth (no schema drift).
 *
 * Schema shape:
 *   - polling adapters: top-level `properties` are flat
 *     credential fields.
 *   - webhook adapters: top-level `properties` is exactly two
 *     keys — `auth` and `webhook_secret` — each a sub-schema of
 *     fields. The route splits the two halves into TWO
 *     `credentialStore.write` calls.
 *
 * `secret: true` flags fields the UI masks AND the route
 * routes through credentialStore (never raw INSERT).
 */
import { describe, expect, it } from "vitest";

import {
  SOURCE_ADAPTER_CREDENTIAL_SCHEMAS,
  type SourceAdapterCredentialDescriptor,
  type SourceAdapterSlug,
} from "../src/source-adapter/credential-schemas.js";

describe("SOURCE_ADAPTER_CREDENTIAL_SCHEMAS", () => {
  const ALL_SLUGS = ["drive", "asana", "n8n", "fireflies", "okf"] as const satisfies readonly SourceAdapterSlug[];

  it("declares an entry for every wired SourceAdapter", () => {
    for (const slug of ALL_SLUGS) {
      const d = SOURCE_ADAPTER_CREDENTIAL_SCHEMAS[slug];
      expect(d, `missing descriptor for slug=${slug}`).toBeDefined();
    }
  });

  it("each descriptor declares either mode='polling' or mode='webhook'", () => {
    for (const slug of ALL_SLUGS) {
      const d: SourceAdapterCredentialDescriptor =
        SOURCE_ADAPTER_CREDENTIAL_SCHEMAS[slug];
      expect(["polling", "webhook"]).toContain(d.mode);
    }
  });

  it("drive is mode='polling'", () => {
    expect(SOURCE_ADAPTER_CREDENTIAL_SCHEMAS.drive.mode).toBe("polling");
  });

  it("n8n is mode='polling'", () => {
    expect(SOURCE_ADAPTER_CREDENTIAL_SCHEMAS.n8n.mode).toBe("polling");
  });

  it("asana is mode='webhook'", () => {
    expect(SOURCE_ADAPTER_CREDENTIAL_SCHEMAS.asana.mode).toBe("webhook");
  });

  it("fireflies is mode='webhook'", () => {
    expect(SOURCE_ADAPTER_CREDENTIAL_SCHEMAS.fireflies.mode).toBe("webhook");
  });

  it("okf is mode='polling' with an empty credential schema (a local OKF bundle has no secret)", () => {
    const okf = SOURCE_ADAPTER_CREDENTIAL_SCHEMAS.okf;
    expect(okf.mode).toBe("polling");
    expect(Object.keys(okf.credentialSchema.properties)).toEqual([]);
    expect(okf.credentialSchema.required).toEqual([]);
  });

  it("polling-mode credentialSchema is type='object' with non-empty `properties`", () => {
    const drive = SOURCE_ADAPTER_CREDENTIAL_SCHEMAS.drive;
    expect(drive.credentialSchema.type).toBe("object");
    expect(Object.keys(drive.credentialSchema.properties).length).toBeGreaterThan(0);
  });

  it("polling-mode flags at least one secret: true field", () => {
    for (const slug of ["drive", "n8n"] as const) {
      const props = SOURCE_ADAPTER_CREDENTIAL_SCHEMAS[slug].credentialSchema.properties;
      const hasSecret = Object.values(props).some(
        (p) => p !== undefined && "secret" in p && p.secret === true,
      );
      expect(hasSecret, `${slug} has no secret-flagged field`).toBe(true);
    }
  });

  it("webhook-mode credentialSchema has exactly two top-level keys: 'auth' and 'webhook_secret'", () => {
    for (const slug of ["asana", "fireflies"] as const) {
      const d = SOURCE_ADAPTER_CREDENTIAL_SCHEMAS[slug];
      const keys = Object.keys(d.credentialSchema.properties).sort();
      expect(keys).toEqual(["auth", "webhook_secret"]);
    }
  });

  it("webhook-mode `auth` and `webhook_secret` halves each declare at least one secret field", () => {
    for (const slug of ["asana", "fireflies"] as const) {
      const d = SOURCE_ADAPTER_CREDENTIAL_SCHEMAS[slug];
      const auth = d.credentialSchema.properties.auth;
      const ws = d.credentialSchema.properties.webhook_secret;
      expect(auth, `${slug}.auth missing`).toBeDefined();
      expect(ws, `${slug}.webhook_secret missing`).toBeDefined();
      // Both halves are sub-schemas with a `properties` map.
      const authProps = (auth as { properties: Record<string, unknown> }).properties;
      const wsProps = (ws as { properties: Record<string, unknown> }).properties;
      const authHasSecret = Object.values(authProps).some(
        (p) => typeof p === "object" && p !== null && "secret" in p && (p as { secret: unknown }).secret === true,
      );
      const wsHasSecret = Object.values(wsProps).some(
        (p) => typeof p === "object" && p !== null && "secret" in p && (p as { secret: unknown }).secret === true,
      );
      expect(authHasSecret, `${slug}.auth has no secret-flagged field`).toBe(true);
      expect(wsHasSecret, `${slug}.webhook_secret has no secret-flagged field`).toBe(true);
    }
  });
});
