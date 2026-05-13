#!/usr/bin/env bash
# bin/opencoo-bootstrap-host.sh — PR-Z7 (phase-a appendix #12, closes G13).
#
# Idempotent host hardening for a fresh Debian 12+ or Ubuntu 22.04+ cloud-init
# VM. Brings the box to an opencoo-ready state in one re-runnable script.
#
# Codifies the pre-cutover sequence that every partner deployment otherwise
# repeats by hand: install Docker + base packages, create a non-root opencoo
# user with docker + sudo membership, lock down sshd (no root, no password,
# no kbd-interactive), enable UFW with the three opencoo ports, enable
# fail2ban, enable security-only unattended-upgrades.
#
# Usage:
#   sudo bin/opencoo-bootstrap-host.sh [--non-interactive] [--admin-pubkey-file <path>]
#
# Flags:
#   --non-interactive          Pass dpkg-reconfigure / apt-get a non-interactive
#                              frontend so the script doesn't block on prompts.
#                              Use this from cloud-init / Ansible / Terraform.
#   --admin-pubkey-file <path> Append the contents of <path> to
#                              /home/opencoo/.ssh/authorized_keys (deduped).
#                              Required for first-time setup if you intend to
#                              SSH in as `opencoo` after the sshd lockdown
#                              takes effect — once PasswordAuthentication=no
#                              is reloaded, a key is the only way in.
#   --help, -h                 Show this help and exit 0.
#
# Output:
#   Each step emits a one-line JSON event to stdout:
#     {"step":"<id>","status":"<installed|configured|skipped|failed>","details":"..."}
#   The final line is a summary:
#     {"event":"bootstrap-host","steps_completed":N,"steps_skipped":M,"steps_failed":F}
#
# Exit code:
#   0 on success (steps_failed == 0).
#   1 on usage error.
#   2 on any step failure (steps_failed > 0).
#
# Idempotency:
#   Every step is safe to re-run. The second invocation against an
#   already-bootstrapped host should emit "skipped" for every step that
#   already converged. The tests/test-bootstrap-host-idempotent.sh test
#   pins that property under RUN_SHELL_TESTS=1.

set -u  # nounset on; do NOT set -e — we want every step to run so the
        # final summary is meaningful even if one early step fails.

# ----------------------------------------------------------------------------
# Constants — keep these together near the top per the front-load rule.
# ----------------------------------------------------------------------------

readonly SCRIPT_NAME="opencoo-bootstrap-host"
readonly OPENCOO_USER="opencoo"
readonly OPENCOO_UID="1001"
readonly OPENCOO_HOME="/home/${OPENCOO_USER}"
readonly SSHD_DROPIN="/etc/ssh/sshd_config.d/99-opencoo.conf"
# Ports allowed inbound:
#   22  — SSH (locked down further by sshd_config.d/99-opencoo.conf).
#   80  — HTTP (Caddy/Traefik does the LE HTTP-01 challenge + 308 redirect).
#   443 — HTTPS (engine UI + Gitea UI + the MCP server, all behind one reverse proxy).
readonly UFW_TCP_ALLOW=(22 80 443)

# Counters for the summary line.
STEPS_COMPLETED=0
STEPS_SKIPPED=0
STEPS_FAILED=0

# ----------------------------------------------------------------------------
# JSON event emitter — keep events on one line for grep-ability.
# ----------------------------------------------------------------------------

# Escape a string for safe inclusion in a JSON double-quoted value.
# Handles backslash + double-quote + the four control chars we might see
# from package-manager output. Anything more exotic is replaced with a
# space; this is logging, not a transport.
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
  # emit <step> <status> <details>
  local step="$1"
  local status="$2"
  local details="${3:-}"
  printf '{"step":"%s","status":"%s","details":"%s"}\n' \
    "$(json_escape "$step")" \
    "$(json_escape "$status")" \
    "$(json_escape "$details")"

  case "$status" in
    installed|configured) STEPS_COMPLETED=$((STEPS_COMPLETED + 1)) ;;
    skipped)              STEPS_SKIPPED=$((STEPS_SKIPPED + 1)) ;;
    failed)               STEPS_FAILED=$((STEPS_FAILED + 1)) ;;
    *) ;;  # info-only event, doesn't count
  esac
}

fail_fatal() {
  # Emit a final-summary line then exit non-zero. Used for pre-flight
  # failures (wrong distro, not root) where continuing makes no sense.
  emit "$1" "failed" "$2"
  printf '{"event":"%s","steps_completed":%d,"steps_skipped":%d,"steps_failed":%d}\n' \
    "$SCRIPT_NAME" "$STEPS_COMPLETED" "$STEPS_SKIPPED" "$STEPS_FAILED"
  exit 2
}

# ----------------------------------------------------------------------------
# Argument parsing.
# ----------------------------------------------------------------------------

NON_INTERACTIVE=0
ADMIN_PUBKEY_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive)
      NON_INTERACTIVE=1
      shift
      ;;
    --admin-pubkey-file)
      ADMIN_PUBKEY_FILE="${2:-}"
      if [[ -z "$ADMIN_PUBKEY_FILE" ]]; then
        echo "${SCRIPT_NAME}: --admin-pubkey-file requires a path" >&2
        exit 1
      fi
      shift 2
      ;;
    --admin-pubkey-file=*)
      ADMIN_PUBKEY_FILE="${1#--admin-pubkey-file=}"
      shift
      ;;
    --help|-h)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "${SCRIPT_NAME}: unknown flag: $1 (try --help)" >&2
      exit 1
      ;;
  esac
done

if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
  export DEBIAN_FRONTEND=noninteractive
fi

# ----------------------------------------------------------------------------
# Pre-flight: must run as root.
# ----------------------------------------------------------------------------

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  emit "preflight-root" "failed" "must run as root (try: sudo $0)"
  printf '{"event":"%s","steps_completed":0,"steps_skipped":0,"steps_failed":1}\n' \
    "$SCRIPT_NAME"
  exit 2
fi

# ----------------------------------------------------------------------------
# Step 1 — Detect distro. Supported: Debian 12+, Ubuntu 22.04+.
# ----------------------------------------------------------------------------

step_detect_distro() {
  if [[ ! -r /etc/os-release ]]; then
    fail_fatal "detect-distro" "/etc/os-release missing — unsupported host"
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  local id="${ID:-unknown}"
  local version_id="${VERSION_ID:-0}"
  # VERSION_ID may be "12", "22.04", or "12.5". Compare on the major.
  local major="${version_id%%.*}"

  case "$id" in
    debian)
      if (( major < 12 )); then
        fail_fatal "detect-distro" "Debian ${version_id} unsupported (need 12+)"
      fi
      emit "detect-distro" "configured" "debian ${version_id}"
      ;;
    ubuntu)
      # Ubuntu major numbers are years; 22 is 22.04 LTS.
      if (( major < 22 )); then
        fail_fatal "detect-distro" "Ubuntu ${version_id} unsupported (need 22.04+)"
      fi
      emit "detect-distro" "configured" "ubuntu ${version_id}"
      ;;
    *)
      fail_fatal "detect-distro" "distro '${id}' unsupported (need debian|ubuntu)"
      ;;
  esac
}

# ----------------------------------------------------------------------------
# Step 2 — Update package index + install base packages.
# ----------------------------------------------------------------------------
#
# Base packages required for the rest of the script:
#   curl                  — get.docker.com fetch + later runtime use
#   ca-certificates       — TLS roots for curl
#   ufw                   — firewall
#   fail2ban              — sshd brute-force protection
#   unattended-upgrades   — automatic security updates
#   jq                    — used by opencoo-gitea-bootstrap.sh; install here
#                           so the operator doesn't need a second apt pass
#   gnupg                 — apt key handling (Docker repo, etc.)
#
# Idempotent: dpkg-query checks every package; if all are installed we
# skip the apt-get install entirely.

step_install_base() {
  local pkgs=(curl ca-certificates ufw fail2ban unattended-upgrades jq gnupg)
  local missing=()
  local p
  for p in "${pkgs[@]}"; do
    if ! dpkg-query -W -f='${Status}\n' "$p" 2>/dev/null | grep -q 'install ok installed'; then
      missing+=("$p")
    fi
  done

  if [[ "${#missing[@]}" -eq 0 ]]; then
    emit "install-base-packages" "skipped" "all ${#pkgs[@]} packages already installed"
    return 0
  fi

  # Refresh apt cache only when we actually need to install something.
  if ! apt-get update -qq >/dev/null 2>&1; then
    emit "install-base-packages" "failed" "apt-get update failed"
    return 1
  fi

  if apt-get install -y -q "${missing[@]}" >/dev/null 2>&1; then
    emit "install-base-packages" "installed" "installed: ${missing[*]}"
  else
    emit "install-base-packages" "failed" "apt-get install failed for: ${missing[*]}"
    return 1
  fi
}

# ----------------------------------------------------------------------------
# Step 3 — Install Docker via get.docker.com.
# ----------------------------------------------------------------------------
#
# Idempotent: presence of `docker` binary short-circuits. Otherwise we
# fetch and run the official convenience script (`curl ... | sh`), then
# verify with `docker run --rm hello-world`. Hello-world is yanked if
# it ever drops out of Docker Hub's free tier, in which case we still
# pass on a successful `docker version` (server reachable).

step_install_docker() {
  if command -v docker >/dev/null 2>&1; then
    emit "install-docker" "skipped" "docker $(docker --version 2>/dev/null | head -1)"
    return 0
  fi

  local tmp
  tmp="$(mktemp)" || { emit "install-docker" "failed" "mktemp failed"; return 1; }
  # shellcheck disable=SC2064
  # Expand $tmp at trap-set time on purpose — the function-local var
  # would not exist if the RETURN trap fired during cleanup.
  trap "rm -f '$tmp'" RETURN

  if ! curl --fail-with-body --silent --show-error --location \
       --output "$tmp" https://get.docker.com 2>/dev/null; then
    emit "install-docker" "failed" "curl https://get.docker.com failed"
    return 1
  fi

  if ! sh "$tmp" >/dev/null 2>&1; then
    emit "install-docker" "failed" "get.docker.com install script returned non-zero"
    return 1
  fi

  # Start + enable Docker (the official script does this on most distros
  # but not all — re-enabling is a no-op if it's already running).
  systemctl enable --now docker >/dev/null 2>&1 || true

  # Smoke test. hello-world is small enough to pull cheaply.
  if docker run --rm hello-world >/dev/null 2>&1; then
    emit "install-docker" "installed" "docker installed + hello-world ran"
  elif docker version >/dev/null 2>&1; then
    # hello-world unavailable but daemon is reachable — accept.
    emit "install-docker" "installed" "docker installed (hello-world skipped; daemon reachable)"
  else
    emit "install-docker" "failed" "docker installed but daemon not reachable"
    return 1
  fi
}

# ----------------------------------------------------------------------------
# Step 4 — Create the opencoo system user.
# ----------------------------------------------------------------------------
#
# UID 1001 keeps it out of the way of any humans the operator may add
# at 1000 / 1002 / ... The user is in `docker` (so it can talk to
# /var/run/docker.sock without sudo — required for compose) and `sudo`
# (so the operator can `sudo -iu opencoo` and then escalate if needed).
#
# Idempotent: `id -u opencoo` short-circuits.

step_create_user() {
  if id -u "$OPENCOO_USER" >/dev/null 2>&1; then
    # Still ensure group membership — if Docker was installed AFTER the
    # user, the user wasn't in `docker` yet. Re-add is a no-op.
    usermod -aG docker "$OPENCOO_USER" 2>/dev/null || true
    usermod -aG sudo   "$OPENCOO_USER" 2>/dev/null || true
    emit "create-opencoo-user" "skipped" "user '${OPENCOO_USER}' exists; group membership reconciled"
    return 0
  fi

  # --create-home gives us $OPENCOO_HOME with the right skeleton.
  # --shell /bin/bash because the operator will need an interactive shell.
  if useradd \
       --uid "$OPENCOO_UID" \
       --user-group \
       --create-home \
       --home-dir "$OPENCOO_HOME" \
       --shell /bin/bash \
       "$OPENCOO_USER" 2>/dev/null; then
    # Docker may not exist yet on a fresh box; we wrap the add to swallow
    # the "group does not exist" case. The install-docker step calls
    # usermod -aG docker as a follow-up only if the user already existed
    # (handled above) — for this branch, we add it now if the group is
    # present and rely on Docker's post-install script otherwise.
    if getent group docker >/dev/null 2>&1; then
      usermod -aG docker "$OPENCOO_USER" 2>/dev/null || true
    fi
    if getent group sudo >/dev/null 2>&1; then
      usermod -aG sudo "$OPENCOO_USER" 2>/dev/null || true
    fi
    # Lock the password so console / SSH password login is impossible
    # regardless of sshd config — defense in depth.
    passwd -l "$OPENCOO_USER" >/dev/null 2>&1 || true
    emit "create-opencoo-user" "installed" "user '${OPENCOO_USER}' uid=${OPENCOO_UID}"
  else
    emit "create-opencoo-user" "failed" "useradd '${OPENCOO_USER}' failed"
    return 1
  fi
}

# ----------------------------------------------------------------------------
# Step 5 — Install the admin SSH pubkey (if provided).
# ----------------------------------------------------------------------------
#
# This is the operator's escape hatch. Once Step 6 reloads sshd with
# PasswordAuthentication=no, a working pubkey is the only way in. If
# --admin-pubkey-file is unset, we skip (operator may already have
# put it in via cloud-init metadata).
#
# Dedupe: we read the existing file, drop any line that matches the
# new key verbatim, then append. Idempotent re-runs add nothing.

step_install_pubkey() {
  if [[ -z "$ADMIN_PUBKEY_FILE" ]]; then
    emit "install-admin-pubkey" "skipped" "no --admin-pubkey-file flag"
    return 0
  fi
  if [[ ! -r "$ADMIN_PUBKEY_FILE" ]]; then
    emit "install-admin-pubkey" "failed" "pubkey file not readable: ${ADMIN_PUBKEY_FILE}"
    return 1
  fi

  local ssh_dir="${OPENCOO_HOME}/.ssh"
  local auth_keys="${ssh_dir}/authorized_keys"
  install -d -m 0700 -o "$OPENCOO_USER" -g "$OPENCOO_USER" "$ssh_dir"

  # Touch the file so the dedupe read works on first run.
  if [[ ! -e "$auth_keys" ]]; then
    install -m 0600 -o "$OPENCOO_USER" -g "$OPENCOO_USER" /dev/null "$auth_keys"
  fi

  local new_key
  new_key="$(cat "$ADMIN_PUBKEY_FILE")"
  if [[ -z "$new_key" ]]; then
    emit "install-admin-pubkey" "failed" "pubkey file empty: ${ADMIN_PUBKEY_FILE}"
    return 1
  fi

  # Compare each non-blank, non-comment line of the new file against
  # what's already in authorized_keys. Skip duplicates.
  local appended=0
  local line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if grep -Fxq -- "$line" "$auth_keys" 2>/dev/null; then
      continue
    fi
    printf '%s\n' "$line" >> "$auth_keys"
    appended=$((appended + 1))
  done < "$ADMIN_PUBKEY_FILE"

  chmod 0600 "$auth_keys"
  chown "$OPENCOO_USER:$OPENCOO_USER" "$auth_keys"

  if [[ "$appended" -eq 0 ]]; then
    emit "install-admin-pubkey" "skipped" "all keys already in authorized_keys"
  else
    emit "install-admin-pubkey" "configured" "appended ${appended} pubkey line(s)"
  fi
}

# ----------------------------------------------------------------------------
# Step 6 — sshd lockdown drop-in.
# ----------------------------------------------------------------------------
#
# Writes /etc/ssh/sshd_config.d/99-opencoo.conf so the lockdown sits in
# the drop-in dir (Debian 12 + Ubuntu 22.04 both source it from the
# stock sshd_config). The drop-in is a literal write; if the file
# already contains exactly these directives, we skip the write but
# still reload sshd to be sure the running daemon matches the file
# on disk.

step_sshd_lockdown() {
  local desired
  desired="$(cat <<'CONF'
# Managed by opencoo-bootstrap-host.sh — do not edit by hand.
# Locks down sshd: no root login, no passwords, no keyboard-interactive.
# Reverse this by deleting the file and reloading ssh.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
CONF
)"

  install -d -m 0755 /etc/ssh/sshd_config.d

  local needs_write=1
  if [[ -f "$SSHD_DROPIN" ]]; then
    if [[ "$(cat "$SSHD_DROPIN")" == "$desired" ]]; then
      needs_write=0
    fi
  fi

  if [[ "$needs_write" -eq 1 ]]; then
    # Write atomically: write to a tempfile next to the target then mv.
    local tmp="${SSHD_DROPIN}.tmp.$$"
    printf '%s\n' "$desired" > "$tmp"
    chmod 0644 "$tmp"
    mv "$tmp" "$SSHD_DROPIN"
  fi

  # Validate before reloading — `sshd -t` parses /etc/ssh/sshd_config
  # plus all drop-ins. Refuse to reload a broken config.
  if ! sshd -t 2>/dev/null; then
    emit "sshd-lockdown" "failed" "sshd -t rejected drop-in; reload skipped"
    return 1
  fi

  # systemctl reload works on Debian 12 (unit: ssh.service) and Ubuntu
  # 22.04 (unit: ssh.service). The legacy `sshd.service` symlink also
  # works on both. Try the canonical name first.
  if systemctl reload ssh >/dev/null 2>&1 \
     || systemctl reload sshd >/dev/null 2>&1; then
    if [[ "$needs_write" -eq 1 ]]; then
      emit "sshd-lockdown" "configured" "wrote ${SSHD_DROPIN} + reloaded sshd"
    else
      emit "sshd-lockdown" "skipped" "${SSHD_DROPIN} unchanged; sshd reloaded for safety"
    fi
  else
    emit "sshd-lockdown" "failed" "systemctl reload ssh|sshd failed"
    return 1
  fi
}

# ----------------------------------------------------------------------------
# Step 7 — UFW: default-deny inbound, allow opencoo ports, enable.
# ----------------------------------------------------------------------------
#
# Idempotent: ufw allow / default commands are no-ops if the rule
# already exists. We only mark the step as "configured" when at least
# one of the four sub-actions changed state; otherwise "skipped".

step_ufw() {
  if ! command -v ufw >/dev/null 2>&1; then
    emit "ufw-configure" "failed" "ufw binary missing (apt step failed?)"
    return 1
  fi

  local changed=0

  # Capture current state so we can detect what changed.
  local before_status
  before_status="$(ufw status verbose 2>/dev/null || echo "Status: unknown")"

  if ! grep -q '^Default: deny (incoming)' <<<"$before_status"; then
    if ! ufw default deny incoming >/dev/null 2>&1; then
      emit "ufw-configure" "failed" "ufw default deny incoming"
      return 1
    fi
    changed=1
  fi
  if ! grep -q 'Default: allow (outgoing)' <<<"$before_status"; then
    if ! ufw default allow outgoing >/dev/null 2>&1; then
      emit "ufw-configure" "failed" "ufw default allow outgoing"
      return 1
    fi
    changed=1
  fi

  local port
  for port in "${UFW_TCP_ALLOW[@]}"; do
    # `ufw status` includes the rule like "22/tcp ALLOW Anywhere".
    if ! grep -qE "^${port}/tcp.*ALLOW" <<<"$before_status"; then
      if ! ufw allow "${port}/tcp" >/dev/null 2>&1; then
        emit "ufw-configure" "failed" "ufw allow ${port}/tcp"
        return 1
      fi
      changed=1
    fi
  done

  if ! grep -q '^Status: active' <<<"$before_status"; then
    if ! ufw --force enable >/dev/null 2>&1; then
      emit "ufw-configure" "failed" "ufw enable"
      return 1
    fi
    changed=1
  fi

  if [[ "$changed" -eq 0 ]]; then
    emit "ufw-configure" "skipped" "ufw already configured: deny in, allow 22+80+443/tcp"
  else
    emit "ufw-configure" "configured" "deny in / allow out / allow 22+80+443/tcp / enabled"
  fi
}

# ----------------------------------------------------------------------------
# Step 8 — fail2ban: enable + start with the package default sshd jail.
# ----------------------------------------------------------------------------

step_fail2ban() {
  if ! systemctl list-unit-files fail2ban.service >/dev/null 2>&1; then
    emit "fail2ban-enable" "failed" "fail2ban.service unit missing"
    return 1
  fi

  local is_active is_enabled
  is_active="$(systemctl is-active fail2ban 2>/dev/null || echo unknown)"
  is_enabled="$(systemctl is-enabled fail2ban 2>/dev/null || echo unknown)"

  if [[ "$is_active" == "active" && "$is_enabled" == "enabled" ]]; then
    emit "fail2ban-enable" "skipped" "fail2ban already active + enabled"
    return 0
  fi

  if systemctl enable --now fail2ban >/dev/null 2>&1; then
    emit "fail2ban-enable" "configured" "fail2ban enabled + started"
  else
    emit "fail2ban-enable" "failed" "systemctl enable --now fail2ban"
    return 1
  fi
}

# ----------------------------------------------------------------------------
# Step 9 — unattended-upgrades: security updates on.
# ----------------------------------------------------------------------------
#
# The standard config file shipped by the package enables security
# updates by default once /etc/apt/apt.conf.d/20auto-upgrades sets
# both keys to "1". We write that file directly — idempotent, two
# lines, no Debconf round-trip.

step_unattended_upgrades() {
  local target="/etc/apt/apt.conf.d/20auto-upgrades"
  local desired
  desired='APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";'

  local needs_write=1
  if [[ -f "$target" ]] && [[ "$(cat "$target")" == "$desired" ]]; then
    needs_write=0
  fi

  if [[ "$needs_write" -eq 1 ]]; then
    printf '%s\n' "$desired" > "$target"
    chmod 0644 "$target"
  fi

  # The systemd timer auto-runs on Debian/Ubuntu once the config above
  # is present; we don't need to start it explicitly. But we DO want
  # the service unit to be enabled (some minimal images ship it
  # disabled). Best-effort.
  systemctl enable unattended-upgrades >/dev/null 2>&1 || true

  if [[ "$needs_write" -eq 0 ]]; then
    emit "unattended-upgrades" "skipped" "${target} already configured"
  else
    emit "unattended-upgrades" "configured" "wrote ${target}; security updates enabled"
  fi
}

# ----------------------------------------------------------------------------
# Run all steps. Each is wrapped so a failure doesn't short-circuit the
# remainder — the final summary line reports the aggregate.
# ----------------------------------------------------------------------------

step_detect_distro       || true
step_install_base        || true
step_install_docker      || true
step_create_user         || true
step_install_pubkey      || true
step_sshd_lockdown       || true
step_ufw                 || true
step_fail2ban            || true
step_unattended_upgrades || true

printf '{"event":"%s","steps_completed":%d,"steps_skipped":%d,"steps_failed":%d}\n' \
  "$SCRIPT_NAME" "$STEPS_COMPLETED" "$STEPS_SKIPPED" "$STEPS_FAILED"

if (( STEPS_FAILED > 0 )); then
  exit 2
fi
exit 0
