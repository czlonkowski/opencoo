# `bin/` — partner-deployment bootstrap scripts

Two idempotent shell scripts that codify the manual sequences every new
opencoo partner deployment otherwise repeats by hand. Both ship in
**phase-a appendix #12 / PR-Z7** (closes G13 + G14) — the partner
cutover surfaced them as the brittle parts of the install runbook,
and they belonged in the repo, not in a deployment journal.

The scripts are deliberately framework-free (POSIX-ish `bash`, `curl`,
`jq`) so they run from a one-line `ssh` invocation on a freshly-provisioned
VM. They each emit one structured JSON event per step to stdout, which
the operator can pipe to `jq` or to the deployment-journal entry.

## Canonical order

1. **Bring up a fresh Debian 12+ / Ubuntu 22.04+ VM.** Cloud-init is
   fine; the scripts do not depend on a particular provisioning tool.
2. **SSH in as `root`** (the only step where root login is allowed).
3. **Copy your operator SSH pubkey** to the host (e.g. `scp ~/.ssh/id_ed25519.pub root@<host>:/tmp/admin.pub`).
4. **Run the host bootstrap.** This installs Docker + base packages,
   creates the `opencoo` user (uid 1001, member of `docker` + `sudo`),
   locks down sshd (no root, no password, no kbd-interactive), enables
   UFW with 22/80/443 open, enables fail2ban, enables unattended
   security upgrades. **The pubkey flag is required if you intend to
   SSH in again** — once sshd reloads, password login is disabled.
   ```sh
   sudo bin/opencoo-bootstrap-host.sh --non-interactive \
     --admin-pubkey-file /tmp/admin.pub
   ```
5. **Re-SSH as the `opencoo` user.** Verify Docker works without sudo:
   `docker ps`.
6. **Pull and start your `compose.yml`** with opencoo + Gitea +
   Postgres + Redis. Wait for the Gitea container to become healthy
   (the engine usually races it on first boot; tolerate one `restart`).
7. **Run the Gitea bootstrap.** This creates the initial admin user
   via `gitea admin user create` (or `docker exec` into the Gitea
   container if the binary isn't on the host PATH), mints a PAT
   named `opencoo-bootstrap` with the scopes opencoo needs, creates
   the org repository, creates the `opencoo-admins` team in that org
   with `owner` permission, and adds the admin to the team:
   ```sh
   export OPENCOO_GITEA_ADMIN_PASSWORD='choose-a-strong-one-or-omit-to-generate'
   bin/opencoo-gitea-bootstrap.sh https://git.example.test acme
   ```
   If `OPENCOO_GITEA_ADMIN_PASSWORD` is unset, the script generates a
   32-char random one and writes it to
   `./secrets/gitea-admin-password.txt` (mode 0600) next to the PAT.
8. **Plug the PAT into opencoo's `.env`.** The PAT path defaults to
   `./secrets/gitea-pat.txt` (configurable via `--secret-out`). The
   `compose.yml` already expects to bind-mount the `secrets/` dir.

After step 8, restart the opencoo engine container; its first
`wikiWrite` call against the new org should succeed.

## What each script emits

Both scripts emit one JSON event per step to stdout:

```jsonc
{"step":"install-base-packages","status":"installed","details":"installed: curl ca-certificates ufw fail2ban unattended-upgrades jq gnupg"}
{"step":"install-docker","status":"installed","details":"docker installed + hello-world ran"}
// ... one per step ...
{"event":"opencoo-bootstrap-host","steps_completed":7,"steps_skipped":2,"steps_failed":0}
```

Status values:

- `installed` / `created` / `configured` — step changed the host state.
- `skipped` / `exists` — step's target state was already in place.
- `failed` — step did not converge; the final summary's `steps_failed`
  counter is non-zero and the script exits non-zero.

The final line is an `event` summary (the host script) or includes the
admin / org / team_id / pat_file fields (the Gitea script).

## Idempotency

Every step is safe to re-run. The expected output of a second
invocation against an already-bootstrapped host:

- Host script — every step reports `skipped` (or, for sshd, `skipped`
  because the drop-in already matches on disk).
- Gitea script — `create-admin-user`, `create-org`, `create-team`
  report `exists`. `mint-pat` rotates the PAT (it has no other way
  to land a usable secret on disk; the existing PAT's plaintext is
  unrecoverable) and reports `configured`. `add-admin-to-team` is the
  idempotent `PUT teams/<id>/members/<name>` (Gitea returns 204 for
  both add and already-member) and reports `configured`.

The two scripts under `bin/tests/` pin these guarantees — both gated
behind `RUN_SHELL_TESTS=1` so they don't run in the default vitest
matrix (each needs the Docker daemon + ~60–120s):

```sh
RUN_SHELL_TESTS=1 bash bin/tests/test-bootstrap-host-idempotent.sh
RUN_SHELL_TESTS=1 bash bin/tests/test-gitea-bootstrap-idempotent.sh
```

## Failure modes worth knowing

- **Step 6 (sshd lockdown) reloads `ssh` mid-script.** If your current
  session relies on password auth, your next reconnect will fail.
  Always pass `--admin-pubkey-file` to the host script on the first
  run.
- **The host script does not configure swap, set the timezone, or
  manage hostname.** These are partner-specific decisions; cloud-init
  metadata is the right place.
- **The Gitea script's PAT rotates on every run.** Re-run only when
  you want a fresh secret; otherwise the engine's previously-cached
  PAT will start returning 401 on its next call. The engine reads
  the PAT from disk on boot, so a `docker compose restart engine`
  after re-running picks up the new secret.
- **`gitea admin user create` runs against the container if the host
  doesn't have the `gitea` binary.** Set `--container` if your
  Gitea service is named differently from the default `gitea`
  (e.g. `gitea_app_1` for a `docker-compose --project-name app`
  deployment).

## Style notes

The scripts deliberately do not require `set -e`. Each step is
wrapped to allow downstream steps to run even if an early one fails,
so the operator gets a complete picture from one invocation instead
of having to fix-and-retry one step at a time. The summary line +
exit code (0 if `steps_failed == 0`, else 2) is the authoritative
success signal.
