# opencoo — contributing

Operator-facing contributor notes. Engineering norms (TDD, types, testing tiers, ESLint boundaries) live in `CONVENTIONS.md`. Security checklist lives in `THREAT-MODEL.md` §5. Phased delivery plan lives in `IMPLEMENTATION-PLAN.md`. Read those first; this file only documents the local-environment plumbing that doesn't fit elsewhere.

---

## Git hooks

`pnpm install` (or any `pnpm` invocation that triggers the `prepare` script) installs Husky and activates two git hooks:

- `.husky/post-merge` — runs after `git pull` / `git merge`.
- `.husky/post-checkout` — runs after `git checkout <branch>` (only on branch checkouts; single-file checkouts like `git checkout -- foo` are skipped).

Both hooks delegate to `.husky/_postmerge-impl.sh`, which:

1. Diffs the previous HEAD against the new HEAD for changes to `pnpm-lock.yaml` or any `package.json`.
2. Runs `pnpm install --silent` if any of those changed.
3. Always runs `pnpm build`, capturing full output to `/tmp/postmerge-build.log` and surfacing it on failure.

The "always rebuild" step is intentional. Phase-a appendices #6 and #7 both closed twice on the same merge-order regression — `pnpm test` on `main` after a merge cycle surfaced bugs that each PR's CI passed in isolation, because workspace dependencies' `dist/` directories were stale relative to consumer expectations. Turbo's own caching makes the no-op case fast; the cost of rebuilding when nothing changed is small relative to the cost of a confusing test failure on `main`.

### When the hook runs

| Trigger | What runs |
|---|---|
| `git pull` (fast-forward or merge) | post-merge: install if lockfile / package.json changed, then build |
| `git merge <branch>` | post-merge: same as above |
| `git checkout <branch>` | post-checkout: same as above |
| `git checkout -- file` | post-checkout: short-circuits (file checkout, not branch switch) |
| Initial clone with `pnpm install` | Husky installs hooks but post-merge does not fire (no `ORIG_HEAD`) |

### Bypassing the hook

Two equivalent bypasses, both honored by the impl:

```sh
HUSKY=0 git pull              # husky's own bypass; disables ALL husky hooks
GIT_NO_VERIFY=1 git pull      # opencoo-specific bypass; same effect for these hooks
```

Use `HUSKY=0` if you want to skip every husky hook; use `GIT_NO_VERIFY=1` for symmetry across opencoo-defined hooks (we'll keep this name stable as we add more hooks). If you reach for either of these often, the hook's wasting your time — file an issue.

### Opting out entirely

If you don't want any post-merge / post-checkout automation on your machine, two options:

1. Per-developer: edit your local `.husky/post-merge` to `exit 0` as the first line. Don't commit the change. (Husky tracks the file, not its content; your edits stick across `pnpm install` runs unless `husky init` re-runs, which only happens if `.husky/` is removed.)
2. Globally: `export HUSKY=0` in your shell profile.

CI explicitly does not run hooks — `actions/checkout@v4` clones without triggering `prepare`, and CI's `pnpm install --frozen-lockfile` followed by `pnpm build` are run as separate steps. The hook is dev-machine convenience only.

### Why Husky and not Lefthook

Husky is the v0.1 choice. It's the most familiar git-hook manager in the npm ecosystem, has a tiny install footprint, and was demonstrably zero-friction to wire here. Lefthook is faster and has cleaner monorepo support; if Husky becomes a friction point we'll revisit. (Plan: phase-a appendix #8 PR-P2.)

---

## Toolchain expectations

- Node 22+ (`engines.node` in root `package.json`).
- pnpm 9.15.4 (`packageManager` in root `package.json`).
- macOS / Linux supported. Windows untested; WSL is your friend.

The full `pnpm` + `turbo` + Drizzle + vitest + ESLint toolchain is described in `IMPLEMENTATION-PLAN.md` §0 (pre-coding gate). Run `pnpm install` from a fresh clone and you should be ready to `pnpm lint && pnpm typecheck && pnpm test`.
