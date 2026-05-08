/**
 * Drift-prevention test (PR-Q9 of phase-a appendix #9).
 *
 * The shared `SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS` registry hand-
 * authors a JSON Schema for asana that the engine's admin API
 * surfaces to the Management UI. The actual validation source of
 * truth is THIS package's `asanaBindingConfigSchema` (Zod) — the
 * adapter parses persisted config through it at scan/webhook time.
 *
 * Both must agree on which fields are required. This test asserts
 * the Zod required-set matches the JSON Schema's `required[]` so
 * a Zod-level edit cannot silently leak past UI validation.
 *
 * If you change the Zod schema and this test fails, update
 * `packages/shared/src/source-adapter/binding-config-schemas.ts`
 * to mirror the new required-set.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS } from "@opencoo/shared/source-adapter";

import { asanaBindingConfigSchema } from "../src/index.js";

/** Walk a Zod object schema and return the keys whose `parse({})`
 *  step would fail because the field has no default + is not
 *  optional. Mirrors how the JSON-Schema `required[]` list is
 *  meant to be consumed (UI required-marker + server validator). */
function zodRequiredKeys(schema: z.ZodObject<z.ZodRawShape>): string[] {
  const required: string[] = [];
  for (const [key, field] of Object.entries(schema.shape)) {
    // Zod treats a field as "required" when:
    //   - it is NOT a ZodOptional, and
    //   - it has NO `.default(...)` clause.
    // Zod 4 flattens `z.string().min(1).default(...)` into a
    // `ZodDefault` wrapper at runtime; the safest probe is a
    // structural parse against `undefined` (a synthetic empty
    // input forces every Required gate to fire).
    const probe = (field as z.ZodTypeAny).safeParse(undefined);
    if (!probe.success) {
      required.push(key);
    }
  }
  return required.sort();
}

describe("asana binding-config schema drift (PR-Q9)", () => {
  it("Zod required-set matches the shared JSON-Schema required[]", () => {
    const zodRequired = zodRequiredKeys(
      asanaBindingConfigSchema as unknown as z.ZodObject<z.ZodRawShape>,
    );
    const jsonRequired = [
      ...SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS["asana"].required,
    ].sort();
    expect(jsonRequired).toEqual(zodRequired);
  });

  it("every JSON-Schema property name corresponds to a Zod schema field", () => {
    const zodKeys = new Set(
      Object.keys(
        (asanaBindingConfigSchema as unknown as z.ZodObject<z.ZodRawShape>).shape,
      ),
    );
    const jsonKeys = Object.keys(
      SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS["asana"].properties,
    );
    for (const k of jsonKeys) {
      expect(
        zodKeys.has(k),
        `JSON-Schema declares "${k}" but Zod schema has no such field`,
      ).toBe(true);
    }
  });
});
