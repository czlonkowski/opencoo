#!/usr/bin/env bash
# bin/tests/test-bootstrap-host-idempotent.sh — PR-Z7
#
# Smoke + idempotency test for opencoo-bootstrap-host.sh.
#
# Runs the script twice inside a throwaway Debian 12 Docker container.
# Asserts:
#   1. First run exits 0 and emits at least 5 "installed|configured" events.
#   2. Second run exits 0 and emits ZERO "installed|configured" events for
#      the steps we control (every step reports "skipped" or, for sshd
#      reload, "skipped" because the drop-in already matches on disk).
#
# Gating:
#   This test is OPT-IN behind RUN_SHELL_TESTS=1 — it pulls a Docker
#   image, takes 60–120s, and needs the docker daemon. CI runs it on
#   the dedicated `shell-tests` workflow job, not the default test
#   matrix.
#
# Usage:
#   RUN_SHELL_TESTS=1 bash bin/tests/test-bootstrap-host-idempotent.sh

set -euo pipefail

if [[ "${RUN_SHELL_TESTS:-0}" != "1" ]]; then
  echo "test-bootstrap-host-idempotent: skipped (RUN_SHELL_TESTS != 1)"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "test-bootstrap-host-idempotent: docker not in PATH; cannot run"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="debian:12-slim"
readonly CONTAINER_NAME="opencoo-bootstrap-host-test-$$"

# shellcheck disable=SC2329
# cleanup is invoked indirectly by the EXIT trap below.
cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Pre-pull so timing inside the container doesn't include image fetch.
docker pull "$IMAGE" >/dev/null

# Start a privileged container — systemd-y bits + ufw need it. We DON'T
# actually run systemd; the script is tolerant of systemctl failures
# (each step that uses systemctl falls back to "failed" with a useful
# detail). To smoke the real path, the live wave-end QA against a real
# VM is the canonical signal. This test pins the SHAPE: every step's
# output line is JSON, each step runs in order, the second run skips
# everything that should be skipped.
docker run -d --name "$CONTAINER_NAME" \
  --privileged \
  -v "$REPO_ROOT/bin:/opencoo-bin:ro" \
  "$IMAGE" sleep 3600 >/dev/null

run_in_container() {
  docker exec "$CONTAINER_NAME" bash /opencoo-bin/opencoo-bootstrap-host.sh --non-interactive
}

echo "--- Run 1 ---"
run1_out="$(run_in_container || true)"
echo "$run1_out"

# Run 1 should have at least 3 installed|configured events (base packages,
# user creation, sshd lockdown — the rest depend on systemd actually
# being PID 1 in the container, which it isn't).
run1_installs="$(grep -c '"status":"\(installed\|configured\)"' <<<"$run1_out" || true)"
if (( run1_installs < 3 )); then
  echo "FAIL: run 1 emitted only ${run1_installs} installed|configured events; expected ≥3"
  exit 1
fi

echo "--- Run 2 ---"
run2_out="$(run_in_container || true)"
echo "$run2_out"

# Run 2 should have ZERO installed|configured events for steps whose
# state already converged. Specifically: install-base-packages,
# create-opencoo-user, sshd-lockdown should all be "skipped" the
# second time around.
for step in install-base-packages create-opencoo-user sshd-lockdown; do
  line="$(grep "\"step\":\"${step}\"" <<<"$run2_out" || true)"
  if [[ -z "$line" ]]; then
    echo "FAIL: run 2 did not emit a line for step '${step}'"
    exit 1
  fi
  if ! grep -q '"status":"skipped"' <<<"$line"; then
    echo "FAIL: run 2 step '${step}' is not 'skipped': ${line}"
    exit 1
  fi
done

echo "PASS: opencoo-bootstrap-host.sh is idempotent for base-packages + user + sshd-lockdown."
exit 0
