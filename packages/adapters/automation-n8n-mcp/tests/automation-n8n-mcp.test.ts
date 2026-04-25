/**
 * automation-n8n-mcp adapter tests (PR 25 / plan #120).
 *
 * Two layers:
 *   1. AutomationAdapter implementation tests — the package's
 *      createAutomationN8nMcpAdapter factory must satisfy
 *      AutomationAdapter from engine-self-operating. Note: the
 *      engine type is imported only at the type level inside
 *      adapter.ts; this package lives under packages/adapters/
 *      so the no-cross-engine-import lint rule does not apply
 *      (it gates engine-to-engine traffic).
 *   2. Gate-3 RUNTIME enforcement (THREAT-MODEL §2 invariant 7):
 *      - the body sent to n8nApi.createWorkflow always carries
 *        the active-disabled literal (the only such literal in
 *        package src is at the single body-build site, plus the
 *        Zod schema definition).
 *      - the local N8nLikeApi.createWorkflow SIGNATURE has no
 *        active parameter.
 *      - the Zod-level n8nWorkflowBodySchema enforces the
 *        active-disabled literal as belt+suspenders.
 *      - n8nMcpCredentialSchema has no activation field.
 *
 * The test asserts behavior against makeMockN8nApi(state). No
 * Docker, no real n8n.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  InMemoryCredentialStore,
  type CredentialStore,
} from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { OutputAdapterError } from "@opencoo/shared/output-adapter";

import {
  AUTOMATION_N8N_MCP_SLUG,
  builderSkills,
  createAutomationN8nMcpAdapter,
  n8nMcpCredentialSchema,
  n8nWorkflowBodySchema,
  tools,
  type AutomationN8nMcpAdapter,
  type BuilderSkill,
  type BuilderToolDescriptor,
  type N8nLikeApi,
} from "../src/index.js";
import {
  createMockN8nApiState,
  makeMockN8nApi,
  type MockN8nApiState,
  type N8nUpstreamBehavior,
} from "../src/testing/mock-n8n-api.js";

const SECRET_PAT = "SECRET-PAT-12345-do-not-leak";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedToken(
  store: CredentialStore,
): Promise<CredentialId> {
  return store.write({
    name: "n8n-mcp-test-pat",
    schemaRef: "n8n-mcp/v1",
    plaintext: Buffer.from(SECRET_PAT),
  });
}

interface FixtureOptions {
  readonly behavior?: N8nUpstreamBehavior;
  readonly wrapStore?: (store: CredentialStore) => CredentialStore;
  readonly baseUrl?: string;
}

interface Fixture {
  readonly store: CredentialStore;
  readonly credentialId: CredentialId;
  readonly state: MockN8nApiState;
  readonly adapter: AutomationN8nMcpAdapter;
}

async function makeFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const baseStore = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId = await seedToken(baseStore);
  const store = opts.wrapStore !== undefined ? opts.wrapStore(baseStore) : baseStore;
  const state = createMockN8nApiState();
  if (opts.behavior !== undefined) state.behavior = opts.behavior;
  const adapter = createAutomationN8nMcpAdapter({
    credentialStore: store,
    credentialId,
    baseUrl: opts.baseUrl ?? "https://n8n.example.test",
    makeApi: () => makeMockN8nApi(state),
  });
  return { store, credentialId, state, adapter };
}

// ---------------------------------------------------------------------------
// Public surface — exports the orchestrator pinned
// ---------------------------------------------------------------------------

describe("automation-n8n-mcp — public surface", () => {
  it("exports {tools, builderSkills, credentialSchema} (PR 25 acceptance)", () => {
    expect(Array.isArray(tools)).toBe(true);
    expect(Array.isArray(builderSkills)).toBe(true);
    expect(n8nMcpCredentialSchema.type).toBe("object");
  });

  it("slug is 'n8n-mcp'", async () => {
    const { adapter } = await makeFixture();
    expect(adapter.slug).toBe(AUTOMATION_N8N_MCP_SLUG);
    expect(adapter.slug).toBe("n8n-mcp");
  });
});

// ---------------------------------------------------------------------------
// Credential schema — Gate 3 schema layer
// ---------------------------------------------------------------------------

describe("automation-n8n-mcp — credential schema (Gate 3 schema-level)", () => {
  it("declares the secret n8nApiToken field", () => {
    const field = n8nMcpCredentialSchema.properties["n8nApiToken"];
    expect(field?.type).toBe("string");
    expect(field?.secret).toBe(true);
  });

  it("requires n8nApiToken", () => {
    expect(n8nMcpCredentialSchema.required).toContain("n8nApiToken");
  });

  it("has NO activation/enable/toggle field (Gate 3 — schema layer)", () => {
    // Defense-in-depth: even if a future PR misuses the credential
    // schema as a config-knob carrier, an activation flag must
    // not be allowed in.
    const keys = Object.keys(n8nMcpCredentialSchema.properties);
    for (const k of keys) {
      const lower = k.toLowerCase();
      expect(lower.includes("activat")).toBe(false);
      expect(lower.includes("enabl")).toBe(false);
      expect(lower.includes("toggle")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Vendored n8n-skills baseline
// ---------------------------------------------------------------------------

describe("automation-n8n-mcp — vendored builder skills", () => {
  it("loads at least one BuilderSkill from the vendored snapshot", () => {
    expect(builderSkills.length).toBeGreaterThan(0);
  });

  it("every BuilderSkill has the required {slug, version, sha, body} keys", () => {
    for (const s of builderSkills) {
      const skill: BuilderSkill = s;
      expect(typeof skill.slug).toBe("string");
      expect(skill.slug.length).toBeGreaterThan(0);
      expect(typeof skill.version).toBe("string");
      expect(typeof skill.sha).toBe("string");
      expect(typeof skill.body).toBe("string");
    }
  });

  it("BuilderSkill slugs are unique across the bundle", () => {
    const seen = new Set<string>();
    for (const s of builderSkills) {
      expect(seen.has(s.slug), `duplicate BuilderSkill slug: ${s.slug}`).toBe(false);
      seen.add(s.slug);
    }
  });
});

// ---------------------------------------------------------------------------
// `tools` — static BuilderToolDescriptor[]
// ---------------------------------------------------------------------------

describe("automation-n8n-mcp — tools surface", () => {
  it("every tool descriptor has {name, description, inputSchema}", () => {
    for (const t of tools) {
      const tool: BuilderToolDescriptor = t;
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.inputSchema).toBe("object");
    }
  });

  it("`tools` does NOT contain seeded credential bytes (open question 9)", () => {
    // Defense-in-depth: a future bug that bakes a credential
    // string into a tool descriptor (e.g. as a default value)
    // shows up here.
    const stringified = JSON.stringify(tools);
    expect(stringified).not.toContain(SECRET_PAT);
    expect(stringified).not.toContain("SECRET");
  });

  it("tool names contain none of the forbidden activation verbs", () => {
    for (const t of tools) {
      const lower = t.name.toLowerCase();
      expect(lower.includes("activat")).toBe(false);
      expect(lower.includes("enabl")).toBe(false);
      expect(lower.includes("toggle")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// deployWorkflow — Gate 3 RUNTIME layer
// ---------------------------------------------------------------------------

describe("automation-n8n-mcp — deployWorkflow Gate 3 runtime", () => {
  it("calls n8n REST createWorkflow with body.active === false (load-bearing Gate 3 runtime pin)", async () => {
    const { adapter, state } = await makeFixture();
    await adapter.deployWorkflow({
      templateSlug: "noop",
      resolvedParams: { greeting: "hello" },
      skillsUsed: [],
    });
    expect(state.calls).toHaveLength(1);
    const body = state.calls[0]?.body;
    expect(body).toBeDefined();
    expect(body?.active).toBe(false);
  });

  it("returns { n8nWorkflowId } EXACTLY — Object.keys === ['n8nWorkflowId']", async () => {
    const { adapter } = await makeFixture();
    const result = await adapter.deployWorkflow({
      templateSlug: "noop",
      resolvedParams: {},
      skillsUsed: [],
    });
    expect(typeof result.n8nWorkflowId).toBe("string");
    expect(result.n8nWorkflowId.length).toBeGreaterThan(0);
    expect(Object.keys(result)).toEqual(["n8nWorkflowId"]);
  });

  it("does NOT leak credential bytes in the returned result (no-raw-credentials-in-result)", async () => {
    const { adapter } = await makeFixture();
    const result = await adapter.deployWorkflow({
      templateSlug: "noop",
      resolvedParams: { foo: "bar" },
      skillsUsed: [],
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_PAT);
  });

  it("forwards the bearer token from CredentialStore on every deploy (rotation pin)", async () => {
    let readCount = 0;
    const { adapter, state } = await makeFixture({
      wrapStore: (store) => ({
        read: (id) => {
          readCount += 1;
          return store.read(id);
        },
        write: (input) => store.write(input),
        rotate: (id, plaintext) => store.rotate(id, plaintext),
        delete: (id) => store.delete(id),
      }),
    });
    await adapter.deployWorkflow({
      templateSlug: "noop",
      resolvedParams: {},
      skillsUsed: [],
    });
    await adapter.deployWorkflow({
      templateSlug: "noop",
      resolvedParams: {},
      skillsUsed: [],
    });
    expect(readCount).toBe(2);
    // Both calls saw the secret token.
    expect(state.calls).toHaveLength(2);
    for (const call of state.calls) {
      expect(call.bearerToken).toBe(SECRET_PAT);
    }
  });

  it("Zod-level body schema rejects body with active:true (belt+suspenders Gate 3)", () => {
    const ok = n8nWorkflowBodySchema.safeParse({
      name: "x",
      nodes: [],
      connections: {},
      settings: {},
      active: false,
    });
    expect(ok.success).toBe(true);

    const bad = n8nWorkflowBodySchema.safeParse({
      name: "x",
      nodes: [],
      connections: {},
      settings: {},
      active: true,
    });
    expect(bad.success).toBe(false);
  });

  it("uses n8n API v1 path", async () => {
    const { adapter, state } = await makeFixture();
    await adapter.deployWorkflow({
      templateSlug: "noop",
      resolvedParams: {},
      skillsUsed: [],
    });
    expect(state.calls[0]?.apiVersion).toBe("v1");
  });
});

// ---------------------------------------------------------------------------
// Error taxonomy — 401 / 429 / 5xx / 4xx classification
// ---------------------------------------------------------------------------

describe("automation-n8n-mcp — error taxonomy", () => {
  it("classifies HTTP 401 as validation (auth failure — DLQ; not retried)", async () => {
    const { adapter } = await makeFixture({
      behavior: { kind: "http-error", status: 401 },
    });
    try {
      await adapter.deployWorkflow({
        templateSlug: "noop",
        resolvedParams: {},
        skillsUsed: [],
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OutputAdapterError);
      expect((err as OutputAdapterError).errorClass).toBe("validation");
    }
  });

  it("classifies HTTP 429 with Retry-After as upstream-quota with retryAfterSeconds", async () => {
    const { adapter } = await makeFixture({
      behavior: { kind: "http-error", status: 429, retryAfterSeconds: 90 },
    });
    try {
      await adapter.deployWorkflow({
        templateSlug: "noop",
        resolvedParams: {},
        skillsUsed: [],
      });
      throw new Error("expected throw");
    } catch (err) {
      const e = err as OutputAdapterError;
      expect(e.errorClass).toBe("upstream-quota");
      expect(e.retryAfterSeconds).toBe(90);
    }
  });

  it("classifies HTTP 503 as transient", async () => {
    const { adapter } = await makeFixture({
      behavior: { kind: "http-error", status: 503 },
    });
    try {
      await adapter.deployWorkflow({
        templateSlug: "noop",
        resolvedParams: {},
        skillsUsed: [],
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as OutputAdapterError).errorClass).toBe("transient");
    }
  });

  it("classifies HTTP 400 as validation", async () => {
    const { adapter } = await makeFixture({
      behavior: { kind: "http-error", status: 400 },
    });
    try {
      await adapter.deployWorkflow({
        templateSlug: "noop",
        resolvedParams: {},
        skillsUsed: [],
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as OutputAdapterError).errorClass).toBe("validation");
    }
  });

  it("classifies a network drop (transient SDK error) as transient", async () => {
    const { adapter } = await makeFixture({
      behavior: { kind: "transient" },
    });
    try {
      await adapter.deployWorkflow({
        templateSlug: "noop",
        resolvedParams: {},
        skillsUsed: [],
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as OutputAdapterError).errorClass).toBe("transient");
    }
  });
});

// ---------------------------------------------------------------------------
// Source-grep regression — `active: false` literal count
// ---------------------------------------------------------------------------

describe("automation-n8n-mcp — Gate 3 source-grep (single body-build site)", () => {
  it("the literal `active: false` appears in exactly ONE place in src/**/*.ts", () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const srcDir = resolve(HERE, "../src");
    const files = walkTs(srcDir);
    let totalMatches = 0;
    const offenders: string[] = [];
    for (const f of files) {
      const source = readFileSync(f, "utf8");
      // Strip comments — they may legitimately reference Gate 3
      // by name.
      const codeOnly = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const m = codeOnly.match(/active\s*:\s*false/g);
      if (m && m.length > 0) {
        totalMatches += m.length;
        offenders.push(`${f}: ${m.length}`);
      }
    }
    // Exactly one site: the body-build site in adapter.ts. The
    // Zod schema's `active: z.literal(false)` does not match
    // this regex (the `z.literal(` infix breaks the pattern),
    // and that's deliberate — the schema layer is separately
    // pinned by the rejects-active-true test below.
    expect(
      totalMatches,
      `expected exactly 1 match (single body-build site) but saw ${totalMatches}: ${offenders.join(", ")}`,
    ).toBe(1);
  });

  it("src/**/*.ts contains no activate/enable/toggle verbs (case-insensitive, comments stripped)", () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const srcDir = resolve(HERE, "../src");
    const files = walkTs(srcDir);
    for (const f of files) {
      const source = readFileSync(f, "utf8");
      const codeOnly = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(
        codeOnly.toLowerCase(),
        `forbidden activation verb in ${f}`,
      ).not.toMatch(/activate(d)?|enable(d)?|toggle(d)?/);
    }
  });
});

// ---------------------------------------------------------------------------
// Type-level pin — the local API surface MUST NOT have an `active` parameter
// ---------------------------------------------------------------------------

describe("automation-n8n-mcp — N8nLikeApi shape (Gate 3 type-level extension)", () => {
  it("createWorkflow signature contains no `active` parameter at the type level", () => {
    // Compile-time pin: this conditional narrows to `never` if
    // the createWorkflow args ever gain an `active` key. Forcing
    // assignment to `true` makes that surface as a TS error.
    type Args = Parameters<N8nLikeApi["createWorkflow"]>[0];
    type _NoActiveOnArgs = "active" extends keyof Args ? never : true;
    const ok: _NoActiveOnArgs = true;
    expect(ok).toBe(true);
  });
});

function walkTs(dir: string): string[] {
  // Lazy synchronous walk — small package, no perf cost.
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTs(p));
    } else if (entry.isFile() && p.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}
