#!/usr/bin/env bash
# Runs ./kit provision (twice) and destroy (twice) against fake doctl/hcloud that keep
# state in files. Checks the second provision reuses everything and destroy cleans up.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
export FAKE_STATE="$WORK/provider" KIT_STATE_DIR="$WORK/kit" PATH="$ROOT/test/fake-providers:$PATH"
mkdir -p "$FAKE_STATE"
ssh-keygen -q -t ed25519 -N "" -f "$WORK/key"
export KIT_SSH_KEY="$WORK/key"
fail() { echo "FAIL: $*"; exit 1; }
for p in "do" hetzner; do
  find "$FAKE_STATE" -type f -delete
  "$ROOT/kit" provision --provider "$p" --yes --no-wait >/dev/null
  [ "$(find "$FAKE_STATE" -type f ! -name calls.log ! -name 'sshkey.*' ! -name hz.key ! -name 'tag.*' ! -name attached | wc -l)" -eq 3 ] || fail "$p: expected server, volume, firewall"
  : >"$FAKE_STATE/calls.log"
  out="$("$ROOT/kit" provision --provider "$p" --yes --no-wait)"
  [[ "$out" == *"already exists"* ]] || fail "$p: second provision did not reuse the server"
  ! grep -q " create" "$FAKE_STATE/calls.log" || fail "$p: second provision created something"
  "$ROOT/kit" destroy --yes >/dev/null
  [ "$(find "$FAKE_STATE" -type f ! -name calls.log | wc -l)" -eq 0 ] || fail "$p: destroy left resources (incl. tag and kit-made SSH key)"
  [ ! -f "$KIT_STATE_DIR/state" ] || fail "$p: destroy left kit state"
  out="$("$ROOT/kit" destroy --provider "$p" --yes)"
  [[ "$out" == *"already gone"* ]] || fail "$p: second destroy not a no-op"
  echo "ok: $p provision x2, destroy x2"
done

# DigitalOcean skipping the volume attach at create: provision must notice and attach it.
find "$FAKE_STATE" -type f -delete
FAKE_SKIP_ATTACH=1 "$ROOT/kit" provision --provider "do" --yes --no-wait >/dev/null
[ -e "$FAKE_STATE/attached" ] || fail "do: provision did not attach a volume DigitalOcean left detached"
grep -q "compute volume-action attach" "$FAKE_STATE/calls.log" || fail "do: no attach call"
"$ROOT/kit" destroy --yes >/dev/null
echo "ok: do provision attaches a volume left detached"
find "$WORK" -type f -delete
