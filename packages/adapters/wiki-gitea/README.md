# @opencoo/wiki-gitea

`WikiAdapter` implementation backed by Gitea's REST API. The sanctioned transport tier under `@opencoo/shared/wiki-write` — the orchestrator (queue, retries, delete-cap, commit-message build) stays in shared; this package owns the wire calls.

Implements the `WikiAdapter` port from `@opencoo/shared/wiki-write` and is verified by the 13-assertion `wikiAdapterContract` from `@opencoo/shared/adapter-contract-tests/wiki-adapter`.

## Pass-through invariants (Correction A from PR-11)

The adapter is a verbatim transport. `wikiWrite()` upstream already builds the full commit message — including the tag prefix, body, `Co-authored-by:` trailers, and `Opencoo-Instance:` trailer. The adapter:

- writes `WriteAtomicArgs.commitMessage` byte-for-byte;
- treats `WriteAtomicArgs.coAuthors` as informational ONLY (telemetry / logging at the transport tier — never injected into commit text);
- preserves `args.author.name`/`args.author.email` byte-for-byte as the git commit author and committer.

Every one of these is locked by `wikiAdapterContract` assertions 8–10.

## Domain → repo binding

```
domainSlug "exec"  →  {owner}/{repoPrefix}-exec   e.g. opencoo/wiki-exec
domainSlug "hr"    →  {owner}/{repoPrefix}-hr     e.g. opencoo/wiki-hr
```

`owner`, `repoPrefix`, and `branch` are constructor-time configuration (not env). The orchestration layer (PR-12+) wires them in from Postgres-managed `domains` config.

## Usage

```ts
import { giteaWikiAdapter, GiteaRestClient } from "@opencoo/wiki-gitea";
import { wikiWrite, InMemoryDeleteCap, InMemoryWikiWriteQueue } from "@opencoo/shared/wiki-write";

const client = new GiteaRestClient({
  url: "https://gitea.example.com",
  token: process.env.GITEA_PAT!, // PAT loaded via the credential-store, not env, in production
});

const adapter = giteaWikiAdapter({
  client,
  owner: "opencoo",
  repoPrefix: "wiki",
  branch: "main",
});

await wikiWrite(
  {
    adapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: new InMemoryDeleteCap(),
    logger,
    clock: () => new Date(),
    instanceId: "prod-a",
  },
  { /* WikiWriteInput */ },
);
```

## What the adapter does on top of the Gitea API

1. **Path-guard belt-and-suspenders.** Every `op.path` is re-validated through `validatePath()` before any wire call. `wikiWrite()` already runs this at orchestration time; doing it again at the adapter layer means a future direct-adapter caller (a CLI, a recovery script) cannot smuggle out-of-bounds writes past the port. Locked by contract assertion 11.
2. **Append resolution.** Gitea has no native `append` operation. The adapter resolves `{mode:'append', path, content}` as read-old + concat + update (or create when the page is missing). Two HTTP calls per append op; v0.1 workload doesn't need batching.
3. **Stale-detect.** Gitea 1.26.0 surfaces sha-mismatch as HTTP 422 with one of three diagnostic phrases (`sha does not match` / `file already exists` / `file does not exist`). The adapter parses the response body and translates those into `{status:'stale', currentSha}` — never throws on stale; that's the normal retry-prompt path. Other 422s (malformed payload, validation errors) bubble through as transport errors.
4. **Pass-through commit message.** `commitMessage` from `WriteAtomicArgs` is forwarded byte-for-byte; `coAuthors` is NOT re-injected (it's already in the message if the caller wanted it).

## Endpoints used

```
GET  /api/v1/repos/{owner}/{repo}/branches/{branch}                      # HEAD sha
GET  /api/v1/repos/{owner}/{repo}/contents/{path}?ref={sha}              # file read
POST /api/v1/repos/{owner}/{repo}/contents                               # batch commit (ChangeFiles)
GET  /api/v1/repos/{owner}/{repo}/git/commits/{sha}                      # CommitInspector
```

Raw `fetch` only — no `gitea-js`, no other SDK. Smaller supply chain; exact request shape under our control. The `GiteaClient` port lets a future adapter (`wiki-github`, `wiki-gitlab`) reuse the orchestration tier with a different transport.

## Testing — two tiers

Use-case tier — runs on every `pnpm test`. `MockGiteaClient` in `src/testing/mock-client.ts` provides hermetic in-memory state:

```bash
pnpm --filter @opencoo/wiki-gitea test
```

Contract tier — runs the same `wikiAdapterContract` against a real Gitea sidecar. Gated on `GITEA_URL` + `GITEA_TOKEN`:

```bash
docker compose -f packages/adapters/wiki-gitea/docker-compose.test.yml up -d gitea
eval "$(./packages/adapters/wiki-gitea/scripts/bootstrap-gitea.sh --eval)"
pnpm --filter @opencoo/wiki-gitea test:contract

# tear down
docker compose -f packages/adapters/wiki-gitea/docker-compose.test.yml down -v
```

The bootstrap script:
- waits for `/api/v1/version` to respond,
- creates an admin user (`wiki-gitea-test:wiki-gitea-test-pw`) inside the container,
- mints a PAT with `write:repository` + `write:user` scope (revoke-and-recreate by name so re-runs are idempotent),
- prints `export GITEA_URL=… GITEA_TOKEN=… GITEA_OWNER=…`.

Each contract test creates a fresh repo (`{owner}/wiki-{slug}`) and deletes it on cleanup.

## Gitea image pin

| Field | Value |
| --- | --- |
| Image | `gitea/gitea:1.26.0` |
| Digest | `sha256:af07b88edbb2173d20932f9c75ebcf4e61d7d5c2d6a7ab5cc6b97cba28aea352` |
| Last reviewed | `2026-04-25` |

CONVENTIONS §6.6 governs the rotation cadence — re-pull `gitea/gitea:latest`, re-run the contract suite, update both the digest and the `Last reviewed` date if the suite still passes. If the API surface changes (e.g., the 422 diagnostic phrases drift), update `isStaleSignalMessage` in `src/client.ts` first and add a regression test before bumping the pin.

## Lint allowlist

`packages/adapters/wiki-gitea/**` is on `no-direct-gitea-write`'s allowlist — see `tools/eslint-plugin-opencoo/src/rules/no-direct-gitea-write.ts`. The rule's intent is unchanged: every Gitea-touching import lives in a named sanctioned place (THREAT-MODEL §2 invariant 2). The set is now {`shared/wiki-write`, `cli/provision`, `adapters/wiki-gitea`}.

## What this package does NOT do

- It does NOT build commit messages — that's `wikiWrite()` in `@opencoo/shared/wiki-write`.
- It does NOT enforce the per-domain delete cap — that's `InMemoryDeleteCap` (PR-12 will move it to Postgres).
- It does NOT manage queueing/retry — the orchestrator's `WikiWriteQueue` does.
- It does NOT touch any Gitea endpoint outside the four listed above. Provisioning Gitea (creating repos, managing teams) lives in `packages/cli/src/provision/` per the load-bearing allowlist.
