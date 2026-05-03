#!/usr/bin/env sh
# .husky/_postmerge-impl.sh — shared install + build implementation for
# the post-merge / post-checkout hooks. Sourced (not exec'd) by the
# wrappers so a single body covers both triggers AND so tests can drive
# it directly with controlled environment.
#
# Phase-a appendix #8 PR-P2. Motivation: appendices #6 + #7 both closed
# with the same merge-order regression — `pnpm test` on `main` after a
# merge cycle surfaced bugs each PR's CI passed in isolation. The cause
# each time was stale `dist/` after a workspace dep changed signatures
# + missing `pnpm install` after a new package landed. The fix is
# mechanical (`pnpm install && pnpm build`); this hook automates it.
#
# Inputs (env):
#   ORIG_HEAD                              git's pre-merge HEAD ref;
#                                          set automatically by `git
#                                          merge` / `git pull`. Empty
#                                          → impl is a no-op (initial
#                                          clone, fresh worktree, etc.)
#   HUSKY=0                                husky's own bypass; impl
#                                          honours it for symmetry
#                                          with the wrapper layer
#   GIT_NO_VERIFY=1                        opencoo-specific bypass;
#                                          documented in
#                                          docs/contributing.md so a
#                                          single env-var name covers
#                                          all our hooks
#
# Test overrides (env, not for production use):
#   OPENCOO_PNPM_BIN                       absolute path to the pnpm
#                                          binary. Defaults to the
#                                          `pnpm` on PATH. Tests point
#                                          this at a fake-pnpm shim
#                                          that records argv to a file.
#   OPENCOO_POSTMERGE_TEST_CHANGED_FILES   newline-or-space-separated
#                                          file list. When set, impl
#                                          uses it instead of running
#                                          `git diff` — keeps tests
#                                          out of the business of
#                                          building real fixture git
#                                          repos.
#   OPENCOO_POSTMERGE_BUILD_LOG            absolute path to the build
#                                          log file. Defaults to
#                                          /tmp/postmerge-build.log.

# Bypass via husky env
if [ "${HUSKY:-1}" = "0" ]; then
  echo "[husky] post-merge: HUSKY=0; skipping install + build"
  return 0 2>/dev/null || exit 0
fi

# Bypass via opencoo-specific env (documented in docs/contributing.md)
if [ "${GIT_NO_VERIFY:-0}" = "1" ]; then
  echo "[husky] post-merge: GIT_NO_VERIFY=1; skipping install + build"
  return 0 2>/dev/null || exit 0
fi

# ORIG_HEAD is set by `git merge` / `git pull` before the post-merge
# hook fires. Empty → no merge ref to diff against (initial clone,
# fresh worktree, manual invocation), so we skip rather than guess.
if [ -z "${ORIG_HEAD:-}" ]; then
  echo "[husky] post-merge: no ORIG_HEAD (no merge ref to diff); skipping"
  return 0 2>/dev/null || exit 0
fi

PNPM="${OPENCOO_PNPM_BIN:-pnpm}"
BUILD_LOG="${OPENCOO_POSTMERGE_BUILD_LOG:-/tmp/postmerge-build.log}"

# Detect lockfile / package.json changes between ORIG_HEAD and HEAD.
# Tests inject the diff via OPENCOO_POSTMERGE_TEST_CHANGED_FILES so
# they don't need a real git repo.
if [ -n "${OPENCOO_POSTMERGE_TEST_CHANGED_FILES+set}" ]; then
  CHANGED="$OPENCOO_POSTMERGE_TEST_CHANGED_FILES"
else
  CHANGED=$(git diff --name-only "$ORIG_HEAD" HEAD -- pnpm-lock.yaml package.json '*/package.json' '**/package.json' 2>/dev/null || echo "")
fi

if [ -n "$CHANGED" ]; then
  echo "[husky] post-merge: lockfile or package.json changed; running pnpm install"
  if ! "$PNPM" install --silent; then
    echo "[husky] post-merge: pnpm install FAILED — see output above"
    return 1 2>/dev/null || exit 1
  fi
fi

# Always rebuild — appendices #6 + #7 both surfaced bugs from stale
# `dist/` even when the lockfile was unchanged. `turbo run build`
# is the cheap belt-and-suspenders fix; turbo's own caching means
# the no-op case is fast.
echo "[husky] post-merge: running pnpm build (full output on failure: $BUILD_LOG)"
if ! "$PNPM" build >"$BUILD_LOG" 2>&1; then
  echo "[husky] post-merge: pnpm build FAILED — full log at $BUILD_LOG:"
  cat "$BUILD_LOG"
  return 1 2>/dev/null || exit 1
fi

echo "[husky] post-merge: install + build complete"
return 0 2>/dev/null || exit 0
