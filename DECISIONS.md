# Open decisions

Running list of architectural and process decisions that haven't been made yet. Each entry is scoped to be answerable in a single conversation turn — decisions expected to take multi-session design work belong in `architecture.md` §17 "Open questions" instead.

**Lifecycle:** when a decision is made, move the resolution paragraph to `docs/decisions-resolved.md` and delete the entry from this file. (The internal `architecture.md` §17 Resolved is the engineering-private counterpart and is updated in the same PR.)

## D4 — `domains.review_role` semantics

`domains.review_role` is currently `text` (nullable) in `packages/shared/src/db/schema/domains.ts`. Two plausible meanings are in flight:

- **(a) role name** — value is a Gitea team name like `operator` or `hr-admins`; plain `text` is correct.
- **(b) user reference** — value is a user ID or Gitea username; the type/constraint should reflect that (uuid → `users.id` FK, or text → `users.gitea_username` FK).

The `users.id` column is uuid PK and `users.gitea_username` is UNIQUE — either could serve as the FK target. Interpretation (a) keeps the current schema; (b) requires a migration that adds the FK and backfills existing rows.

**Trigger:** Review Dashboard authorization logic (IMPLEMENTATION-PLAN.md PR 28) — the first piece of code that needs to resolve `review_role` to an actor. Decide before that PR opens.

**Owner:** TBD.

---

## See also

- **`docs/decisions-resolved.md`** — the canonical contributor-facing list of resolved architectural decisions with one-paragraph rationale per entry. Closing an open decision above lands a paragraph there in the same PR.

- **Deferred design questions** (v2+ features, waiting on real-customer signal; tracked in the internal design-of-record but not promoted to `docs/decisions-resolved.md` until chosen):
  - Review Dashboard v2 inline-edit UX
  - Managed opencoo hosting as a product
  - Fireflies webhook vs Drive-dropped transcripts priority
  - Gitea MCP as projection server
  - Custom agent authoring UI
  - `schema.md` evolution ownership
  - Pattern mining over `catalog-workflows` entries (post-v0.1 pilot target)
  - Catalogs as a top-level primitive (deferred until a third catalog class surfaces)
