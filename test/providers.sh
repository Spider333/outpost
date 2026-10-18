#!/usr/bin/env bash
# Runs ./outpost provision (twice) and destroy (twice) against fake doctl/hcloud that keep
# state in files. Checks the second provision reuses everything and destroy cleans up.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
export FAKE_STATE="$WORK/provider" OUTPOST_STATE_DIR="$WORK/outpost" PATH="$ROOT/test/fake-providers:$PATH"
mkdir -p "$FAKE_STATE"
ssh-keygen -q -t ed25519 -N "" -f "$WORK/key"
export OUTPOST_SSH_KEY="$WORK/key"
fail() { echo "FAIL: $*"; exit 1; }
for p in "do" hetzner; do
  find "$FAKE_STATE" -type f -delete
  "$ROOT/outpost" provision --provider "$p" --yes --no-wait >/dev/null
  [ "$(find "$FAKE_STATE" -type f ! -name calls.log ! -name 'sshkey.*' ! -name hz.key ! -name 'tag.*' | wc -l)" -eq 3 ] || fail "$p: expected server, volume, firewall"
  : >"$FAKE_STATE/calls.log"
  out="$("$ROOT/outpost" provision --provider "$p" --yes --no-wait)"
  [[ "$out" == *"already exists"* ]] || fail "$p: second provision did not reuse the server"
  ! grep -q " create" "$FAKE_STATE/calls.log" || fail "$p: second provision created something"
  "$ROOT/outpost" destroy --yes >/dev/null
  [ "$(find "$FAKE_STATE" -type f ! -name calls.log | wc -l)" -eq 0 ] || fail "$p: destroy left resources (incl. tag and Outpost-made SSH key)"
  [ ! -f "$OUTPOST_STATE_DIR/state" ] || fail "$p: destroy left Outpost state"
  out="$("$ROOT/outpost" destroy --provider "$p" --yes)"
  [[ "$out" == *"already gone"* ]] || fail "$p: second destroy not a no-op"
  echo "ok: $p provision x2, destroy x2"
done
find "$WORK" -type f -delete
