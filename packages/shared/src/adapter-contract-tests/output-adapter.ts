/**
 * Reusable contract suite for the `OutputAdapter` port
 * (architecture §10 / plan #115). Every concrete OutputAdapter
 * (Asana in PR 24, future Slack / email / webhook) runs the
 * same assertion matrix so the boundary stays port-faithful.
 *
 * # Why this lives in `@opencoo/shared`
 *
 * The OutputAdapter port itself is at
 * `@opencoo/shared/output-adapter`; the contract sits next to
 * it. Adapter packages already depend on shared.
 *
 * # 9 assertions (plan #115 + PR 24 overrides + Copilot triage)
 *
 *   1. slug — non-empty stable string.
 *   2. payloadSchema is a Zod schema (.parse exists).
 *   3. credentialSchema is JSON-Schema-shaped (type='object',
 *      properties is a record) AND marks at least one field
 *      with `secret: true` (so the Management UI knows what
 *      to mask + persist via CredentialStore).
 *   4. write(valid payload, valid credentials) → returns
 *      OutputWriteResult with non-empty externalId.
 *   5. write(payload that fails Zod) → throws
 *      OutputAdapterError with `errorClass='validation'`
 *      BEFORE any external call.
 *   6. write(429 from upstream) → throws
 *      OutputAdapterError(upstream-quota) with retryAfterSeconds.
 *   7. write(5xx/network from upstream) → throws
 *      OutputAdapterError(transient).
 *   8. **payload-schema-rejects-extra-keys** (PR 24 override) —
 *      passing an over-keyed payload throws
 *      OutputAdapterError(validation) BEFORE any external call;
 *      the schema MUST be Zod `.strict()`.
 *   9. **no-raw-credentials-in-result** (PR 24 Copilot triage) —
 *      the seeded credential's secret bytes never appear in
 *      `JSON.stringify(OutputWriteResult)`. Defends against an
 *      adapter that accidentally embeds credentials in the
 *      returned `externalUrl` / `externalId`.
 */
import { describe, expect, it } from "vitest";

import type { CredentialStore } from "../credential-store/index.js";
import type { CredentialId } from "../db/brands.js";
import type { OutputAdapter } from "../output-adapter/index.js";

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

export interface OutputAdapterHandle<TPayload> {
  readonly adapter: OutputAdapter<TPayload>;
  /** A real (in-memory) CredentialStore seeded with a credential
   *  the adapter resolves on every write(). Carrying this on the
   *  handle (rather than a NULL store inside the suite) lets
   *  assertion 9 actually exercise the resolve-via-store path
   *  AND assert the secret bytes never leak into
   *  OutputWriteResult. */
  readonly credentialStore: CredentialStore;
  readonly credentialId: CredentialId;
  /** A unique substring present in the seeded credential's
   *  plaintext bytes. Assertion 9 checks `JSON.stringify(result)`
   *  does NOT contain this substring — a regression where the
   *  adapter accidentally returned credential bytes in
   *  OutputWriteResult would surface here. */
  readonly secretMarker: string;
  /** A valid payload the adapter accepts. */
  readonly validPayload: TPayload;
  /** An over-keyed payload the schema must reject (assertion 8).
   *  Same as validPayload + at least one extra key. Cast to
   *  TPayload at the call site so the test can pass it
   *  through to write(). */
  readonly overKeyedPayload: TPayload;
  /** Inject a per-call upstream behavior — `'ok'` is the
   *  default (success). `{httpError: 429, retryAfter: 120}`
   *  forces the rate-limit path. `{httpError: 503}` forces
   *  the transient path. The fixture interprets these against
   *  its own mock-upstream mechanics. */
  readonly programUpstream: (
    behavior: UpstreamBehavior,
  ) => void;
  /** Inspect the captured external-call payload. Tests assert
   *  that the validated payload reached the upstream verbatim,
   *  and that REJECTED payloads never made it. */
  readonly inspectCalls: () => readonly UpstreamCallRecord[];
  readonly cleanup: () => Promise<void>;
}

export type UpstreamBehavior =
  | { readonly kind: "ok" }
  | {
      readonly kind: "http-error";
      readonly status: number;
      readonly retryAfterSeconds?: number;
    }
  | { readonly kind: "transient" };

export interface UpstreamCallRecord {
  readonly payload: unknown;
}

export interface OutputAdapterFixtureOptions<TPayload> {
  readonly backendName: string;
  readonly makeAdapter: () => Promise<OutputAdapterHandle<TPayload>>;
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

export function outputAdapterContract<TPayload>(
  options: OutputAdapterFixtureOptions<TPayload>,
): void {
  describe(`outputAdapterContract / ${options.backendName}`, () => {
    // 1. slug
    it("slug is a non-empty stable string", async () => {
      const handle = await options.makeAdapter();
      try {
        const slug = handle.adapter.slug;
        expect(typeof slug).toBe("string");
        expect(slug.length).toBeGreaterThan(0);
        expect(handle.adapter.slug).toBe(slug);
      } finally {
        await handle.cleanup();
      }
    });

    // 2. payloadSchema is a Zod schema
    it("payloadSchema is a Zod schema (parse + safeParse exist)", async () => {
      const handle = await options.makeAdapter();
      try {
        expect(typeof handle.adapter.payloadSchema.parse).toBe("function");
        expect(typeof handle.adapter.payloadSchema.safeParse).toBe(
          "function",
        );
      } finally {
        await handle.cleanup();
      }
    });

    // 3. credentialSchema is JSON-Schema-shaped + marks at least
    //    one field as secret (the Management UI relies on the
    //    `secret: true` flag to mask + route through CredentialStore).
    it("credentialSchema is type='object' with a properties record AND flags at least one secret field", async () => {
      const handle = await options.makeAdapter();
      try {
        const cs = handle.adapter.credentialSchema;
        expect(cs.type).toBe("object");
        expect(typeof cs.properties).toBe("object");
        expect(cs.properties).not.toBe(null);
        const secretFields = Object.entries(cs.properties).filter(
          ([, field]) => field.secret === true,
        );
        expect(secretFields.length).toBeGreaterThan(0);
      } finally {
        await handle.cleanup();
      }
    });

    // 4. write(valid) → externalId
    it("write(valid payload) returns a non-empty externalId", async () => {
      const handle = await options.makeAdapter();
      try {
        handle.programUpstream({ kind: "ok" });
        const result = await fakeWrite(handle);
        expect(typeof result.externalId).toBe("string");
        expect(result.externalId.length).toBeGreaterThan(0);
        // The validated payload reached the upstream.
        const calls = handle.inspectCalls();
        expect(calls.length).toBeGreaterThan(0);
      } finally {
        await handle.cleanup();
      }
    });

    // 5. write(payload that fails Zod) → OutputAdapterError(validation)
    it("write(invalid payload) throws OutputAdapterError(validation) BEFORE any external call", async () => {
      const handle = await options.makeAdapter();
      try {
        handle.programUpstream({ kind: "ok" });
        // The thrown error MUST carry errorClass='validation' —
        // a plain Error or a transient/upstream-quota class
        // would let agents and the BullMQ retry layer
        // misclassify the failure.
        try {
          await fakeWriteWithRawPayload(handle, {} as unknown as TPayload);
          throw new Error("expected throw");
        } catch (err) {
          const e = err as { errorClass?: string };
          expect(e.errorClass).toBe("validation");
        }
        // No upstream call was made.
        expect(handle.inspectCalls().length).toBe(0);
      } finally {
        await handle.cleanup();
      }
    });

    // 6. 429 → upstream-quota with retryAfterSeconds
    it("write upstream 429 → OutputAdapterError(upstream-quota) with retryAfterSeconds", async () => {
      const handle = await options.makeAdapter();
      try {
        handle.programUpstream({
          kind: "http-error",
          status: 429,
          retryAfterSeconds: 120,
        });
        try {
          await fakeWrite(handle);
          throw new Error("expected throw");
        } catch (err) {
          const e = err as {
            errorClass?: string;
            retryAfterSeconds?: number;
            name?: string;
          };
          expect(e.errorClass).toBe("upstream-quota");
          expect(e.retryAfterSeconds).toBe(120);
        }
      } finally {
        await handle.cleanup();
      }
    });

    // 7. 5xx / network → transient
    it("write upstream 5xx/network → OutputAdapterError(transient)", async () => {
      const handle = await options.makeAdapter();
      try {
        handle.programUpstream({
          kind: "http-error",
          status: 503,
        });
        try {
          await fakeWrite(handle);
          throw new Error("expected throw");
        } catch (err) {
          const e = err as { errorClass?: string };
          expect(e.errorClass).toBe("transient");
        }
      } finally {
        await handle.cleanup();
      }
    });

    // 8. payload-schema-rejects-extra-keys (PR 24 override)
    it("payload schema rejects extra keys (.strict() — defense-in-depth against agent field-smuggling)", async () => {
      const handle = await options.makeAdapter();
      try {
        handle.programUpstream({ kind: "ok" });
        // Direct schema-level pin: parsing the over-keyed
        // payload throws BEFORE the adapter even gets it.
        const parseResult = handle.adapter.payloadSchema.safeParse(
          handle.overKeyedPayload,
        );
        expect(parseResult.success).toBe(false);
        // The adapter's write() also rejects (via the same
        // schema) with errorClass='validation' specifically —
        // not a generic Error, not transient. No upstream call
        // lands.
        try {
          await fakeWriteWithRawPayload(handle, handle.overKeyedPayload);
          throw new Error("expected throw");
        } catch (err) {
          const e = err as { errorClass?: string };
          expect(e.errorClass).toBe("validation");
        }
        expect(handle.inspectCalls().length).toBe(0);
      } finally {
        await handle.cleanup();
      }
    });

    // 9. no-raw-credentials-in-result (Copilot triage on PR 24)
    it("OutputWriteResult never embeds raw credential bytes (no-leak regression guard)", async () => {
      const handle = await options.makeAdapter();
      try {
        handle.programUpstream({ kind: "ok" });
        const result = await fakeWrite(handle);
        // The seeded credential's secret marker MUST NOT appear
        // anywhere in the JSON-stringified result. An adapter
        // accidentally embedding the credential in `externalUrl`
        // (e.g. by formatting an URL with the bearer token)
        // would surface here.
        const rendered = JSON.stringify(result);
        expect(rendered).not.toContain(handle.secretMarker);
      } finally {
        await handle.cleanup();
      }
    });
  });
}

// Helpers — the contract suite calls write() with the fixture's
// real seeded CredentialStore + credentialId. The adapter is
// responsible for resolving credentials through the store; that
// resolution is what assertion 9 then audits for leakage.
async function fakeWrite<TPayload>(
  handle: OutputAdapterHandle<TPayload>,
): Promise<import("../output-adapter/index.js").OutputWriteResult> {
  return fakeWriteWithRawPayload(handle, handle.validPayload);
}

async function fakeWriteWithRawPayload<TPayload>(
  handle: OutputAdapterHandle<TPayload>,
  payload: TPayload,
): Promise<import("../output-adapter/index.js").OutputWriteResult> {
  return handle.adapter.write({
    credentialStore: handle.credentialStore,
    credentialId: handle.credentialId,
    payload,
  });
}
