#!/usr/bin/env bash
# bin/tests/test-gitea-bootstrap-idempotent.sh — PR-Z7
#
# Idempotency test for opencoo-gitea-bootstrap.sh.
#
# Spins up a throwaway Gitea container, runs the bootstrap script twice,
# and asserts:
#   1. First run exits 0 and creates the admin user + PAT + org + team
#      + membership. The summary line has a non-null team_id and a
#      readable pat_file.
#   2. Second run exits 0 and emits "exists" / "skipped" / "configured"
#      for every step (no "created" status). PAT may rotate (-> configured)
#      and admin team membership is the idempotent 204 (-> configured),
#      but admin user and org should both be "exists".
#
# Gating:
#   RUN_SHELL_TESTS=1 (matches test-bootstrap-host-idempotent.sh).
#   Requires `docker` in PATH + outbound internet to pull gitea/gitea.

set -euo pipefail

if [[ "${RUN_SHELL_TESTS:-0}" != "1" ]]; then
  echo "test-gitea-bootstrap-idempotent: skipped (RUN_SHELL_TESTS != 1)"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "test-gitea-bootstrap-idempotent: docker not in PATH; cannot run"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "test-gitea-bootstrap-idempotent: jq not in PATH; cannot run"
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "test-gitea-bootstrap-idempotent: curl not in PATH; cannot run"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
readonly REPO_ROOT
readonly GITEA_IMAGE="gitea/gitea:1.21"
readonly GITEA_CONTAINER="opencoo-gitea-bootstrap-test-$$"
TMP_DIR="$(mktemp -d)"
readonly TMP_DIR
readonly TEST_PORT="$(( 13000 + (RANDOM % 1000) ))"
readonly TEST_URL="http://localhost:${TEST_PORT}"
readonly TEST_ORG="acme"
readonly TEST_ADMIN="opencoo-test-admin"
readonly TEST_EMAIL="admin@opencoo.test"

# shellcheck disable=SC2329
# cleanup is invoked indirectly by the EXIT trap below.
cleanup() {
  docker rm -f "$GITEA_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "--- Starting Gitea on ${TEST_URL} ---"
docker pull "$GITEA_IMAGE" >/dev/null
docker run -d --name "$GITEA_CONTAINER" \
  -p "${TEST_PORT}:3000" \
  -e GITEA__security__INSTALL_LOCK=true \
  -e GITEA__service__DISABLE_REGISTRATION=true \
  "$GITEA_IMAGE" >/dev/null

# Wait for the API to come up — the bootstrap script also polls
# /api/healthz for 60s so an extra wait here mostly ensures the
# subsequent script invocation isn't paying the full deadline.
for _ in {1..30}; do
  if curl -fs "${TEST_URL}/api/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done

OPENCOO_GITEA_ADMIN_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)"
readonly OPENCOO_GITEA_ADMIN_PASSWORD
export OPENCOO_GITEA_ADMIN_PASSWORD

run_bootstrap() {
  OPENCOO_GITEA_ADMIN_PASSWORD="$OPENCOO_GITEA_ADMIN_PASSWORD" \
    bash "$REPO_ROOT/bin/opencoo-gitea-bootstrap.sh" \
      --secret-out "$TMP_DIR/pat.txt" \
      --container "$GITEA_CONTAINER" \
      "$TEST_URL" "$TEST_ORG" "$TEST_ADMIN" "$TEST_EMAIL"
}

echo "--- Run 1 ---"
run1_out="$(run_bootstrap)"
echo "$run1_out"

# Run 1 — admin user + org + team should all be 'created'.
for step in create-admin-user create-org create-team; do
  line="$(grep "\"step\":\"${step}\"" <<<"$run1_out" || true)"
  if [[ -z "$line" ]]; then
    echo "FAIL: run 1 missing step '${step}'"
    exit 1
  fi
  if ! grep -q '"status":"created"' <<<"$line"; then
    echo "FAIL: run 1 step '${step}' status != created: ${line}"
    exit 1
  fi
done

summary1="$(tail -1 <<<"$run1_out")"
team_id="$(jq -r '.team_id // empty' <<<"$summary1")"
pat_file="$(jq -r '.pat_file // empty' <<<"$summary1")"
if [[ -z "$team_id" || "$team_id" == "null" ]]; then
  echo "FAIL: run 1 summary missing team_id: ${summary1}"
  exit 1
fi
if [[ ! -r "$pat_file" ]] || [[ ! -s "$pat_file" ]]; then
  echo "FAIL: run 1 did not write a readable PAT to ${pat_file}"
  exit 1
fi

echo "--- Run 2 ---"
run2_out="$(run_bootstrap)"
echo "$run2_out"

# Run 2 — admin user + org should be 'exists'. Team should be 'exists'
# (was created in run 1). PAT and admin-team membership both report
# 'configured' (PAT rotates intentionally; membership PUT is idempotent
# but we can't distinguish add-vs-already-in from the 204).
for step in create-admin-user create-org create-team; do
  line="$(grep "\"step\":\"${step}\"" <<<"$run2_out" || true)"
  if [[ -z "$line" ]]; then
    echo "FAIL: run 2 missing step '${step}'"
    exit 1
  fi
  if grep -q '"status":"created"' <<<"$line"; then
    echo "FAIL: run 2 step '${step}' is 'created' (expected 'exists'): ${line}"
    exit 1
  fi
done

echo "PASS: opencoo-gitea-bootstrap.sh is idempotent for admin-user + org + team."
exit 0
