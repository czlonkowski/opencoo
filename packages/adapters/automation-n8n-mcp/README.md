# @opencoo/automation-n8n-mcp

`AutomationAdapter` for n8n. Implements the `deployWorkflow` port the
Builder agent uses to materialise an approved automation candidate as a
**deployed but inactive** n8n workflow. Bundles a vendored snapshot of
[`czlonkowski/n8n-skills`](https://github.com/czlonkowski/n8n-skills) so
the Builder has a stable BuilderSkill catalog at v0.1 without a runtime
fetch dependency.

## Status

- v0.1 (PR 25 / plan #120). Use-case-tier tests only — no Docker, no
  network, no real n8n. Production wiring lands in PR 38.
- The `tools` array is **static**; the function-with-filter shape comes
  with the `n8n-mcp` runtime dep in PR 38.
- The vendored `n8n-skills` snapshot lives under `vendor/n8n-skills/`,
  pinned by `vendor/n8n-skills.lock.json` (`{tag, sha, fetchedAt}`).

## Gate 3 — manual activation only (THREAT-MODEL §2 invariant 7)

The Builder NEVER activates a workflow. Activation is an explicit
operator action in the n8n UI. Four enforcement layers hold:

1. **Type level** — `AutomationAdapter` (engine-side) has exactly one
   method, `deployWorkflow`. The local `N8nLikeApi.createWorkflow`
   signature in this package adds a complementary pin: no `active`
   parameter on its argument shape.
2. **Schema level** — `BuilderOutput` has no `activated` field;
   `n8nMcpCredentialSchema` has no activation field.
3. **Runtime level** — the body posted to n8n carries
   `active: false`; the Zod-level `n8nWorkflowBodySchema` enforces
   `z.literal(false)` before the REST call leaves the adapter.
4. **Source-grep** — both the adapter's own test and the cross-package
   regression in `engine-self-operating/tests/automation-loop/
   gate-3-source-grep.test.ts` scan the package src tree for the
   verbs `activate(d)?` / `enable(d)?` / `toggle(d)?` and assert
   exactly one `active: false` literal at the body-build site.

If you find yourself adding an `activate` / `enable` / `toggle` method
or an `active` parameter — STOP. That's a Gate 3 bypass.

## Public surface

```ts
import {
  AUTOMATION_N8N_MCP_SLUG,
  builderSkills,
  createAutomationN8nMcpAdapter,
  n8nMcpCredentialSchema,
  tools,
} from "@opencoo/automation-n8n-mcp";
```

- `createAutomationN8nMcpAdapter({credentialStore, credentialId,
   baseUrl, makeApi})` — adapter factory. The token is resolved from
   the `CredentialStore` on **every** `deployWorkflow` call (rotation
   pin).
- `tools: readonly BuilderToolDescriptor[]` — static catalog of
   read-only tools the Builder LLM has at v0.1.
- `builderSkills: readonly BuilderSkill[]` — vendored n8n-skills.
- `n8nMcpCredentialSchema: OutputCredentialSchema` — the schema the
   Management UI renders. The single field, `n8nApiToken`, is
   `secret: true`.

## Credential field

`n8nApiToken` — n8n REST API token with workflow-create scope. Generate
via the n8n UI → Settings → API → Create API key. The Management UI
masks input on entry; the engine resolves the bytes via the
`CredentialStore` at deploy time.

## API version

n8n's REST API version is hardcoded to `v1` in `n8n-api.ts` for v0.1.
The `n8nApiVersion` slot in the credential schema is reserved for a
future migration; no operator-visible setting in v0.1.

## Vendored skills bundle

`vendor/n8n-skills/` contains one JSON file per skill. Each file
matches `BuilderSkill { slug, version, sha, body, summary? }`. The
`vendor/n8n-skills.lock.json` pin records the upstream tag, commit SHA,
and fetch timestamp.

The current snapshot is a placeholder set of 3 representative entries
(`heartbeat-digest`, `lint-pages`, `dispatch-task`). The
orchestrator's `tools/vendor-n8n-skills.ts` script (PR 38) refreshes
the snapshot from the upstream release and verifies the SHA.

## Tests

```sh
pnpm --filter @opencoo/automation-n8n-mcp test
```

Use-case tier only. The shared tier-discipline rule (CONVENTIONS.md
§3) means: no real n8n, no Docker. The mock REST surface lives at
`src/testing/mock-n8n-api.ts`.
