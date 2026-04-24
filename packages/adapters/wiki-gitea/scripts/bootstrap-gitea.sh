#!/usr/bin/env bash
# Bootstrap a fresh Gitea sidecar for the wiki-gitea contract test:
#
#   1. Wait for /api/v1/version to respond (Gitea ready).
#   2. Create admin user `wiki-gitea-test:wiki-gitea-test-pw` (idempotent).
#   3. Mint a Personal Access Token with repo scope.
#   4. Print export lines for GITEA_URL + GITEA_TOKEN.
#
# Usage:
#   ./packages/adapters/wiki-gitea/scripts/bootstrap-gitea.sh           # human-readable
#   eval $(./packages/adapters/wiki-gitea/scripts/bootstrap-gitea.sh --eval)
#
# Re-running is safe — admin creation is `--must-change-password=false`
# and PAT minting is name-scoped (existing token with the same name is
# revoked + recreated).

set -euo pipefail

GITEA_URL="${GITEA_URL:-http://localhost:3001}"
ADMIN_USER="${WIKI_GITEA_ADMIN:-wiki-gitea-test}"
ADMIN_PW="${WIKI_GITEA_PW:-wiki-gitea-test-pw}"
ADMIN_EMAIL="${WIKI_GITEA_EMAIL:-wiki-gitea-test@opencoo.test}"
TOKEN_NAME="${WIKI_GITEA_TOKEN_NAME:-contract-test}"
CONTAINER="${WIKI_GITEA_CONTAINER:-opencoo-wiki-gitea-test}"

EVAL_MODE=0
if [[ "${1:-}" == "--eval" ]]; then EVAL_MODE=1; fi

log() {
  if [[ $EVAL_MODE -eq 0 ]]; then
    echo "[bootstrap] $*" >&2
  fi
}

log "waiting for ${GITEA_URL}/api/v1/version ..."
attempts=0
until curl -fsS "${GITEA_URL}/api/v1/version" >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [[ $attempts -gt 60 ]]; then
    echo "[bootstrap] gitea did not become ready within 60s" >&2
    exit 1
  fi
  sleep 1
done
log "gitea ready ($(curl -fsS "${GITEA_URL}/api/v1/version" 2>/dev/null))"

# Admin creation runs INSIDE the container — `gitea admin user create`
# is idempotent w.r.t. existing usernames in the sense that it errors
# loud, which we silence + treat as "user already exists".
log "ensuring admin user '${ADMIN_USER}' exists..."
docker exec -u git "${CONTAINER}" gitea admin user create \
  --admin \
  --username "${ADMIN_USER}" \
  --password "${ADMIN_PW}" \
  --email "${ADMIN_EMAIL}" \
  --must-change-password=false 2>&1 | grep -v "user already exists" >/dev/null || true

# Mint PAT via /api/v1/users/{user}/tokens. If a token with the same
# name already exists, delete it first — Gitea would 422 otherwise.
auth="-u ${ADMIN_USER}:${ADMIN_PW}"
existing_id=$(curl -fsS $auth "${GITEA_URL}/api/v1/users/${ADMIN_USER}/tokens" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);[print(t['id']) for t in d if t['name']=='${TOKEN_NAME}']" \
  | head -n1)
if [[ -n "${existing_id}" ]]; then
  log "revoking existing PAT id=${existing_id} name=${TOKEN_NAME}..."
  curl -fsS -X DELETE $auth "${GITEA_URL}/api/v1/users/${ADMIN_USER}/tokens/${existing_id}" >/dev/null
fi

log "minting PAT '${TOKEN_NAME}' with repo scope..."
token_response=$(curl -fsS -X POST $auth \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${TOKEN_NAME}\",\"scopes\":[\"write:repository\",\"write:user\"]}" \
  "${GITEA_URL}/api/v1/users/${ADMIN_USER}/tokens")
token=$(printf '%s' "${token_response}" | python3 -c "import json,sys;print(json.load(sys.stdin)['sha1'])")
if [[ -z "${token}" ]]; then
  echo "[bootstrap] failed to mint PAT — response: ${token_response}" >&2
  exit 1
fi

if [[ $EVAL_MODE -eq 1 ]]; then
  printf 'export GITEA_URL=%q\nexport GITEA_TOKEN=%q\nexport GITEA_OWNER=%q\n' \
    "${GITEA_URL}" "${token}" "${ADMIN_USER}"
else
  log "ok — credentials below; copy to your shell or eval --eval mode:"
  echo
  printf 'export GITEA_URL=%q\nexport GITEA_TOKEN=%q\nexport GITEA_OWNER=%q\n' \
    "${GITEA_URL}" "${token}" "${ADMIN_USER}"
fi
