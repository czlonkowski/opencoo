#!/usr/bin/env bash
# bin/opencoo-gitea-bootstrap.sh — PR-Z7 (phase-a appendix #12, closes G14).
#
# Idempotent Gitea bootstrap: turns a freshly-started Gitea container into
# a ready-to-serve opencoo backend by creating the admin user, minting a
# Personal Access Token, creating the org repository, creating the
# `opencoo-admins` team, and adding the admin to that team.
#
# Codifies the post-`docker compose up` sequence that previously lived
# as four separate API heredocs + one `gitea admin user create` shell-out
# in the deployment journal. Each step that failed silently in a heredoc
# now emits a structured event.
#
# Usage:
#   bin/opencoo-gitea-bootstrap.sh <gitea-url> <org-slug> [admin-username] [admin-email]
#
# Examples:
#   bin/opencoo-gitea-bootstrap.sh http://localhost:3000 acme
#   bin/opencoo-gitea-bootstrap.sh https://git.example.test acme opencoo-admin admin@example.test
#
# Optional flags:
#   --secret-out <path>     Write the PAT to <path> (default: ./secrets/gitea-pat.txt).
#                           File mode 0644 so the engine container can read it
#                           via docker-compose secrets / bind mount.
#   --container <name>      docker exec target for `gitea admin user create`.
#                           Default: gitea. Used only when the gitea CLI is
#                           not in PATH on the host (the common case for
#                           docker-compose deployments).
#   --help, -h              Show help and exit 0.
#
# Required env:
#   OPENCOO_GITEA_ADMIN_PASSWORD — initial admin password. If unset, the
#                                  script generates a 32-char random one
#                                  and emits it on stdout as part of the
#                                  admin-user-create event (so the
#                                  operator can copy it into the password
#                                  manager) AND writes it to a sibling
#                                  file next to the PAT.
#
# Output:
#   One JSON event per step on stdout:
#     {"step":"<id>","status":"<created|exists|configured|skipped|failed>","details":"..."}
#   Final summary:
#     {"event":"gitea-bootstrap","admin":"...","org":"...","team_id":N,"pat_file":"..."}
#
# Exit code:
#   0 on full success.
#   1 on usage error / missing required env.
#   2 on any step failure.
#
# Idempotency:
#   Every API call tolerates the "already exists" case (HTTP 422 from
#   Gitea, or duplicate-name 409). Re-running against a converged Gitea
#   emits "exists" / "skipped" for every step. The
#   tests/test-gitea-bootstrap-idempotent.sh test pins that property
#   under RUN_SHELL_TESTS=1.
#
# Dependencies (all from apt; opencoo-bootstrap-host.sh installs them):
#   curl, jq, docker (optional, only when CLI shell-out is the path).

set -u

# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------

readonly SCRIPT_NAME="gitea-bootstrap"
readonly ADMIN_TEAM_NAME="opencoo-admins"
readonly PAT_NAME="opencoo-bootstrap"
# Scopes per Gitea ≥1.21: tokens use scope strings prefixed `read:` /
# `write:` / `admin:`. opencoo needs to write into per-domain repos
# (`write:repository`), administer org membership (`write:organization`,
# `admin:org`), and read user info for the admin UI's "Connected" panel.
# Drop `admin:org` if you ever want a least-privilege token; the bootstrap
# token gets the bigger scope set so subsequent operator workflows work
# without re-minting.
readonly PAT_SCOPES_JSON='["write:repository","write:organization","read:user","admin:org"]'

# Counters.
STEPS_COMPLETED=0
STEPS_SKIPPED=0
STEPS_FAILED=0

# Fields populated as the script progresses, used in the summary.
TEAM_ID=""
PAT_FILE=""
ADMIN_GENERATED_PASSWORD=""

# ----------------------------------------------------------------------------
# JSON event emitter — same shape as opencoo-bootstrap-host.sh.
# ----------------------------------------------------------------------------

json_escape() {
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

emit() {
  local step="$1"
  local status="$2"
  local details="${3:-}"
  printf '{"step":"%s","status":"%s","details":"%s"}\n' \
    "$(json_escape "$step")" \
    "$(json_escape "$status")" \
    "$(json_escape "$details")"
  case "$status" in
    created|configured) STEPS_COMPLETED=$((STEPS_COMPLETED + 1)) ;;
    exists|skipped)     STEPS_SKIPPED=$((STEPS_SKIPPED + 1)) ;;
    failed)             STEPS_FAILED=$((STEPS_FAILED + 1)) ;;
    *) ;;
  esac
}

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

emit_summary() {
  printf '{"event":"%s","admin":"%s","org":"%s","team_id":%s,"pat_file":"%s","steps_completed":%d,"steps_skipped":%d,"steps_failed":%d}\n' \
    "$SCRIPT_NAME" \
    "$(json_escape "$ADMIN_USER")" \
    "$(json_escape "$ORG_SLUG")" \
    "${TEAM_ID:-null}" \
    "$(json_escape "${PAT_FILE:-}")" \
    "$STEPS_COMPLETED" "$STEPS_SKIPPED" "$STEPS_FAILED"
}

# ----------------------------------------------------------------------------
# Argument parsing.
# ----------------------------------------------------------------------------

GITEA_URL=""
ORG_SLUG=""
ADMIN_USER="opencoo-admin"
ADMIN_EMAIL="admin@opencoo.local"
SECRET_OUT="./secrets/gitea-pat.txt"
GITEA_CONTAINER="gitea"

POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --secret-out)
      SECRET_OUT="${2:-}"
      [[ -z "$SECRET_OUT" ]] && { echo "${SCRIPT_NAME}: --secret-out requires a path" >&2; exit 1; }
      shift 2
      ;;
    --secret-out=*)
      SECRET_OUT="${1#--secret-out=}"
      shift
      ;;
    --container)
      GITEA_CONTAINER="${2:-}"
      [[ -z "$GITEA_CONTAINER" ]] && { echo "${SCRIPT_NAME}: --container requires a name" >&2; exit 1; }
      shift 2
      ;;
    --container=*)
      GITEA_CONTAINER="${1#--container=}"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      echo "${SCRIPT_NAME}: unknown flag: $1 (try --help)" >&2
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

# Re-set positional from the collected array. Guard against `set -u`
# tripping on an empty array (the `+x` form expands to nothing when the
# array is empty, so `set --` clears positionals without error).
if (( ${#POSITIONAL[@]} > 0 )); then
  set -- "${POSITIONAL[@]}"
else
  set --
fi

if [[ "$#" -lt 2 ]]; then
  echo "${SCRIPT_NAME}: missing required positional args" >&2
  echo >&2
  usage >&2
  exit 1
fi

GITEA_URL="$1"
ORG_SLUG="$2"
[[ "$#" -ge 3 && -n "${3:-}" ]] && ADMIN_USER="$3"
[[ "$#" -ge 4 && -n "${4:-}" ]] && ADMIN_EMAIL="$4"

# Trim trailing slash from the URL — the API paths below all start with /.
GITEA_URL="${GITEA_URL%/}"

# ----------------------------------------------------------------------------
# Required-deps pre-flight.
# ----------------------------------------------------------------------------

for dep in curl jq; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    emit "preflight-deps" "failed" "${dep} not in PATH (run opencoo-bootstrap-host.sh first?)"
    printf '{"event":"%s","steps_completed":0,"steps_skipped":0,"steps_failed":1}\n' "$SCRIPT_NAME"
    exit 2
  fi
done

# ----------------------------------------------------------------------------
# Generate or accept the admin password.
# ----------------------------------------------------------------------------

if [[ -z "${OPENCOO_GITEA_ADMIN_PASSWORD:-}" ]]; then
  # Generate from /dev/urandom — 32 url-safe chars. tr -dc filters to
  # the alphanumeric set so the password is safe to pass on the CLI
  # without quoting hassles for the operator. We avoid the `+/=` of
  # base64 for the same reason.
  ADMIN_GENERATED_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32 || true)"
  if [[ -z "$ADMIN_GENERATED_PASSWORD" ]]; then
    emit "generate-admin-password" "failed" "could not read /dev/urandom"
    printf '{"event":"%s","steps_completed":0,"steps_skipped":0,"steps_failed":1}\n' "$SCRIPT_NAME"
    exit 2
  fi
  OPENCOO_GITEA_ADMIN_PASSWORD="$ADMIN_GENERATED_PASSWORD"
  emit "generate-admin-password" "configured" "generated 32-char random password (stored next to PAT)"
else
  emit "generate-admin-password" "skipped" "OPENCOO_GITEA_ADMIN_PASSWORD already set"
fi

# ----------------------------------------------------------------------------
# Step 1 — Wait for Gitea readiness (up to 60s).
# ----------------------------------------------------------------------------
#
# Gitea exposes /api/healthz on every version we target. We poll once
# per second for up to 60s; bail with a `failed` event if the deadline
# passes.

step_wait_for_gitea() {
  local deadline=$(( $(date +%s) + 60 ))
  local http_code
  while (( $(date +%s) < deadline )); do
    http_code="$(curl --silent --show-error --output /dev/null \
                  --write-out '%{http_code}' \
                  --max-time 5 \
                  "${GITEA_URL}/api/healthz" 2>/dev/null || echo "000")"
    if [[ "$http_code" == "200" ]]; then
      emit "wait-for-gitea" "configured" "${GITEA_URL}/api/healthz -> 200"
      return 0
    fi
    sleep 1
  done
  emit "wait-for-gitea" "failed" "${GITEA_URL}/api/healthz never returned 200 (60s deadline)"
  return 1
}

# ----------------------------------------------------------------------------
# Step 2 — Create the admin user.
# ----------------------------------------------------------------------------
#
# Path resolution:
#   (a) If `gitea` is in PATH on the host, run it directly. (Bare-metal
#       deployments fall here.)
#   (b) Else if Docker is in PATH AND a container matching $GITEA_CONTAINER
#       exists AND is running, `docker exec` into it. (Docker-compose
#       deployments fall here — the common case.)
#   (c) Else fail — there's no API equivalent for the first admin user
#       on a fresh Gitea install, so we genuinely can't proceed.
#
# Duplicate handling: `gitea admin user create` exits non-zero with
# stderr containing "user already exists" for re-runs. We capture
# stderr and pattern-match — re-run becomes "exists", not "failed".

run_gitea_cli() {
  # Run a `gitea` subcommand, choosing the host vs. docker exec path.
  # Echoes stdout+stderr; caller checks exit code.
  if command -v gitea >/dev/null 2>&1; then
    gitea "$@" 2>&1
    return $?
  fi
  if command -v docker >/dev/null 2>&1; then
    # Detect a running container matching the name.
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$GITEA_CONTAINER"; then
      # Gitea's container ships the binary at /usr/local/bin/gitea and
      # expects to be invoked as the `git` user.
      docker exec -u git "$GITEA_CONTAINER" gitea "$@" 2>&1
      return $?
    fi
  fi
  echo "gitea CLI not available (binary missing AND no running docker container named '${GITEA_CONTAINER}')" >&2
  return 127
}

step_create_admin_user() {
  local out
  # `--must-change-password=false` is essential for an unattended bootstrap:
  # without it, the admin's first interactive login is forced to rotate
  # the password, which breaks the headless PAT-mint flow that follows.
  out="$(run_gitea_cli admin user create \
           --admin \
           --username "$ADMIN_USER" \
           --email "$ADMIN_EMAIL" \
           --password "$OPENCOO_GITEA_ADMIN_PASSWORD" \
           --must-change-password=false 2>&1)"
  local rc=$?

  if (( rc == 0 )); then
    emit "create-admin-user" "created" "admin '${ADMIN_USER}' created"
    return 0
  fi

  # Tolerate the duplicate-user case — Gitea's CLI returns non-zero
  # with "user already exists" (older versions) or "user already
  # exists [name: ...]" (1.21+).
  if grep -qiE 'user already exists|name has been used' <<<"$out"; then
    emit "create-admin-user" "exists" "admin '${ADMIN_USER}' already present"
    return 0
  fi

  emit "create-admin-user" "failed" "gitea admin user create rc=${rc}: $(echo "$out" | tr '\n' ' ' | head -c 200)"
  return 1
}

# ----------------------------------------------------------------------------
# Step 3 — Mint a PAT for the admin.
# ----------------------------------------------------------------------------
#
# API: POST /api/v1/users/<admin>/tokens
#   Body: { "name": "opencoo-bootstrap", "scopes": [...] }
#   Auth: HTTP Basic admin:password
#   Success: 201, body { "id": N, "name": "...", "sha1": "<token>", ... }
#   Conflict: 422, body { "message": "Token with name 'opencoo-bootstrap' already exists" }
#
# Conflict handling: the token's `sha1` field is only ever returned on
# creation — once you've forgotten it, Gitea won't show it again. So
# our strategy on conflict is:
#   - Delete the existing token (DELETE /api/v1/users/<admin>/tokens/<name>)
#   - Re-create it
#   - Persist the new sha1 to disk
# This is the only way to land a usable PAT on every invocation; an
# alternative "skip if present" path would leave the operator with a
# secret file they can't recover.

step_mint_pat() {
  local tokens_url="${GITEA_URL}/api/v1/users/${ADMIN_USER}/tokens"
  local create_body
  create_body="$(jq -nc \
    --arg name "$PAT_NAME" \
    --argjson scopes "$PAT_SCOPES_JSON" \
    '{name: $name, scopes: $scopes}')"

  local resp
  resp="$(curl --silent --show-error \
            --user "${ADMIN_USER}:${OPENCOO_GITEA_ADMIN_PASSWORD}" \
            --request POST \
            --header 'Content-Type: application/json' \
            --data "$create_body" \
            --write-out '\n%{http_code}' \
            "$tokens_url")"
  local http_code body
  http_code="$(tail -n1 <<<"$resp")"
  body="$(head -n -1 <<<"$resp")"

  if [[ "$http_code" == "201" ]]; then
    local sha1
    sha1="$(jq -r '.sha1 // empty' <<<"$body")"
    if [[ -z "$sha1" ]]; then
      emit "mint-pat" "failed" "201 from Gitea but no sha1 in body"
      return 1
    fi
    write_pat "$sha1"
    emit "mint-pat" "created" "PAT '${PAT_NAME}' minted; secret written to ${PAT_FILE}"
    return 0
  fi

  if [[ "$http_code" == "422" ]] || grep -qi 'already exists\|already been used' <<<"$body"; then
    # Delete + recreate so we have a usable sha1 on disk.
    # Gitea ≥1.20 supports DELETE by token NAME; older versions need
    # DELETE by ID (GET tokens to find it). Try by-name first.
    local del_code
    del_code="$(curl --silent --show-error --output /dev/null \
                  --user "${ADMIN_USER}:${OPENCOO_GITEA_ADMIN_PASSWORD}" \
                  --request DELETE \
                  --write-out '%{http_code}' \
                  "${tokens_url}/${PAT_NAME}")"
    if [[ "$del_code" != "204" && "$del_code" != "200" && "$del_code" != "404" ]]; then
      # Fall back: list tokens, find by name, delete by id.
      local listing token_id
      listing="$(curl --silent --show-error \
                   --user "${ADMIN_USER}:${OPENCOO_GITEA_ADMIN_PASSWORD}" \
                   "$tokens_url")"
      token_id="$(jq -r --arg n "$PAT_NAME" '.[] | select(.name==$n) | .id // empty' <<<"$listing" | head -1)"
      if [[ -n "$token_id" ]]; then
        curl --silent --show-error --output /dev/null \
          --user "${ADMIN_USER}:${OPENCOO_GITEA_ADMIN_PASSWORD}" \
          --request DELETE \
          "${tokens_url}/${token_id}" || true
      fi
    fi

    # Retry create.
    resp="$(curl --silent --show-error \
              --user "${ADMIN_USER}:${OPENCOO_GITEA_ADMIN_PASSWORD}" \
              --request POST \
              --header 'Content-Type: application/json' \
              --data "$create_body" \
              --write-out '\n%{http_code}' \
              "$tokens_url")"
    http_code="$(tail -n1 <<<"$resp")"
    body="$(head -n -1 <<<"$resp")"
    if [[ "$http_code" == "201" ]]; then
      local sha1
      sha1="$(jq -r '.sha1 // empty' <<<"$body")"
      if [[ -z "$sha1" ]]; then
        emit "mint-pat" "failed" "201 from Gitea on retry but no sha1 in body"
        return 1
      fi
      write_pat "$sha1"
      emit "mint-pat" "configured" "PAT '${PAT_NAME}' rotated; secret written to ${PAT_FILE}"
      return 0
    fi
    emit "mint-pat" "failed" "retry after delete returned ${http_code}: $(echo "$body" | tr '\n' ' ' | head -c 200)"
    return 1
  fi

  emit "mint-pat" "failed" "POST ${tokens_url} returned ${http_code}: $(echo "$body" | tr '\n' ' ' | head -c 200)"
  return 1
}

write_pat() {
  local secret="$1"
  PAT_FILE="$SECRET_OUT"
  local dir
  dir="$(dirname -- "$PAT_FILE")"
  mkdir -p -- "$dir"
  # Write atomically.
  local tmp="${PAT_FILE}.tmp.$$"
  printf '%s\n' "$secret" > "$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$PAT_FILE"

  # If we generated the admin password, persist that next to the PAT so
  # the operator has a single place to retrieve both secrets.
  if [[ -n "$ADMIN_GENERATED_PASSWORD" ]]; then
    local pwfile="${dir}/gitea-admin-password.txt"
    local pwtmp="${pwfile}.tmp.$$"
    printf '%s\n' "$ADMIN_GENERATED_PASSWORD" > "$pwtmp"
    chmod 0600 "$pwtmp"
    mv "$pwtmp" "$pwfile"
  fi
}

# ----------------------------------------------------------------------------
# Step 4 — Create the org.
# ----------------------------------------------------------------------------
#
# API: POST /api/v1/orgs
#   Body: { "username": "<slug>", "visibility": "private" }
#   Success: 201
#   Already-exists: 422 with message "user already exists"
#
# Gitea's org-create endpoint accepts admin auth (the PAT mints with
# admin:org). We use the PAT we just wrote.

step_create_org() {
  if [[ -z "$PAT_FILE" || ! -r "$PAT_FILE" ]]; then
    emit "create-org" "failed" "no PAT available; mint-pat must succeed first"
    return 1
  fi
  local pat
  pat="$(tr -d '\n' < "$PAT_FILE")"

  local body
  body="$(jq -nc --arg u "$ORG_SLUG" '{username: $u, visibility: "private"}')"

  local resp http_code resp_body
  resp="$(curl --silent --show-error \
            --header "Authorization: token ${pat}" \
            --header 'Content-Type: application/json' \
            --request POST \
            --data "$body" \
            --write-out '\n%{http_code}' \
            "${GITEA_URL}/api/v1/orgs")"
  http_code="$(tail -n1 <<<"$resp")"
  resp_body="$(head -n -1 <<<"$resp")"

  case "$http_code" in
    201)
      emit "create-org" "created" "org '${ORG_SLUG}' created (visibility=private)"
      return 0
      ;;
    422)
      if grep -qiE 'already exists|already been used' <<<"$resp_body"; then
        emit "create-org" "exists" "org '${ORG_SLUG}' already present"
        return 0
      fi
      emit "create-org" "failed" "422 from POST /api/v1/orgs: $(echo "$resp_body" | tr '\n' ' ' | head -c 200)"
      return 1
      ;;
    *)
      emit "create-org" "failed" "POST /api/v1/orgs returned ${http_code}: $(echo "$resp_body" | tr '\n' ' ' | head -c 200)"
      return 1
      ;;
  esac
}

# ----------------------------------------------------------------------------
# Step 5 — Create the opencoo-admins team in the org.
# ----------------------------------------------------------------------------
#
# API: POST /api/v1/orgs/<slug>/teams
#   Body: { "name": "opencoo-admins", "permission": "owner",
#           "units": ["repo.code","repo.issues","repo.pulls","repo.releases",
#                     "repo.wiki","repo.ext_wiki","repo.ext_issues","repo.projects"],
#           "includes_all_repositories": true,
#           "can_create_org_repo": true }
#   Conflict: 422 "team already exists"
#
# We need the team ID to add the admin in step 6 — list teams after
# create-or-exists to obtain it.

step_create_team() {
  local pat
  pat="$(tr -d '\n' < "$PAT_FILE")"

  local body
  body="$(jq -nc \
    --arg name "$ADMIN_TEAM_NAME" \
    '{
       name: $name,
       description: "opencoo administrators — managed by opencoo-gitea-bootstrap.sh",
       permission: "owner",
       includes_all_repositories: true,
       can_create_org_repo: true,
       units: ["repo.code","repo.issues","repo.pulls","repo.releases","repo.wiki","repo.ext_wiki","repo.ext_issues","repo.projects"]
     }')"

  local resp http_code resp_body
  resp="$(curl --silent --show-error \
            --header "Authorization: token ${pat}" \
            --header 'Content-Type: application/json' \
            --request POST \
            --data "$body" \
            --write-out '\n%{http_code}' \
            "${GITEA_URL}/api/v1/orgs/${ORG_SLUG}/teams")"
  http_code="$(tail -n1 <<<"$resp")"
  resp_body="$(head -n -1 <<<"$resp")"

  if [[ "$http_code" == "201" ]]; then
    TEAM_ID="$(jq -r '.id // empty' <<<"$resp_body")"
    emit "create-team" "created" "team '${ADMIN_TEAM_NAME}' created (id=${TEAM_ID})"
    return 0
  fi

  # 422 / conflict → look up the team id.
  if [[ "$http_code" == "422" ]] || grep -qiE 'already exists' <<<"$resp_body"; then
    local listing
    listing="$(curl --silent --show-error \
                 --header "Authorization: token ${pat}" \
                 "${GITEA_URL}/api/v1/orgs/${ORG_SLUG}/teams/search?q=${ADMIN_TEAM_NAME}")"
    TEAM_ID="$(jq -r --arg n "$ADMIN_TEAM_NAME" '.data[]? | select(.name==$n) | .id // empty' <<<"$listing" | head -1)"
    if [[ -z "$TEAM_ID" ]]; then
      # Fall back: paginate the org's full team list.
      listing="$(curl --silent --show-error \
                   --header "Authorization: token ${pat}" \
                   "${GITEA_URL}/api/v1/orgs/${ORG_SLUG}/teams")"
      TEAM_ID="$(jq -r --arg n "$ADMIN_TEAM_NAME" '.[] | select(.name==$n) | .id // empty' <<<"$listing" | head -1)"
    fi
    if [[ -z "$TEAM_ID" ]]; then
      emit "create-team" "failed" "team '${ADMIN_TEAM_NAME}' exists per 422 but id lookup failed"
      return 1
    fi
    emit "create-team" "exists" "team '${ADMIN_TEAM_NAME}' already present (id=${TEAM_ID})"
    return 0
  fi

  emit "create-team" "failed" "POST teams returned ${http_code}: $(echo "$resp_body" | tr '\n' ' ' | head -c 200)"
  return 1
}

# ----------------------------------------------------------------------------
# Step 6 — Add admin to opencoo-admins.
# ----------------------------------------------------------------------------
#
# API: PUT /api/v1/teams/<id>/members/<username>
#   Success: 204 (No Content) — both "added" and "already a member".
#
# This step was skipped during a previous live bootstrap and the
# resulting permission gap broke the engine's first wiki-write — we
# explicitly DO call it here. PUT is idempotent by Gitea's design so
# re-runs report "configured" (we can't distinguish add vs already-in
# from a 204).

step_add_admin_to_team() {
  if [[ -z "$TEAM_ID" ]]; then
    emit "add-admin-to-team" "failed" "no team id (create-team must succeed first)"
    return 1
  fi
  local pat
  pat="$(tr -d '\n' < "$PAT_FILE")"

  local code
  code="$(curl --silent --show-error --output /dev/null \
            --header "Authorization: token ${pat}" \
            --request PUT \
            --write-out '%{http_code}' \
            "${GITEA_URL}/api/v1/teams/${TEAM_ID}/members/${ADMIN_USER}")"

  case "$code" in
    204|200)
      emit "add-admin-to-team" "configured" "admin '${ADMIN_USER}' in team id=${TEAM_ID}"
      return 0
      ;;
    *)
      emit "add-admin-to-team" "failed" "PUT teams/${TEAM_ID}/members/${ADMIN_USER} -> ${code}"
      return 1
      ;;
  esac
}

# ----------------------------------------------------------------------------
# Run all steps in order. Bail out of dependent steps if a prerequisite
# fails (PAT mint can't proceed without admin user; team can't be
# created without PAT; admin add needs team).
# ----------------------------------------------------------------------------

step_wait_for_gitea       || { emit_summary; exit 2; }
step_create_admin_user    || { emit_summary; exit 2; }
step_mint_pat             || { emit_summary; exit 2; }
step_create_org           || { emit_summary; exit 2; }
step_create_team          || { emit_summary; exit 2; }
step_add_admin_to_team    || { emit_summary; exit 2; }

emit_summary

if (( STEPS_FAILED > 0 )); then
  exit 2
fi
exit 0
