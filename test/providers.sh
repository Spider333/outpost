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
  [ "$(find "$FAKE_STATE" -type f ! -name calls.log ! -name 'sshkey.*' ! -name hz.key ! -name 'tag.*' ! -name attached | wc -l)" -eq 3 ] || fail "$p: expected server, volume, firewall"
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

# DigitalOcean skipping the volume attach at create: provision must notice and attach it.
find "$FAKE_STATE" -type f -delete
FAKE_SKIP_ATTACH=1 "$ROOT/outpost" provision --provider "do" --yes --no-wait >/dev/null
[ -e "$FAKE_STATE/attached" ] || fail "do: provision did not attach a volume DigitalOcean left detached"
grep -q "compute volume-action attach" "$FAKE_STATE/calls.log" || fail "do: no attach call"
"$ROOT/outpost" destroy --yes >/dev/null
echo "ok: do provision attaches a volume left detached"

# DigitalOcean still listing a volume it has just deleted: a second destroy must not fail.
out="$(FAKE_STALE_VOLUME=outpost-node-data "$ROOT/outpost" destroy --provider "do" --yes 2>&1)" || fail "do: destroy failed on a volume that was already gone: $out"
[[ "$out" == *"volume outpost-node-data: already gone"* ]] || fail "do: destroy did not report the stale volume as gone"
echo "ok: do destroy accepts a volume that is listed but already gone"

# DigitalOcean answering 503 for volume get and delete: destroy must fail and keep the state,
# not call the volume gone.
find "$FAKE_STATE" -type f -delete
"$ROOT/outpost" provision --provider "do" --yes --no-wait >/dev/null
: >"$FAKE_STATE/volume-503"
out="$("$ROOT/outpost" destroy --yes 2>&1)" && fail "do: destroy succeeded while volume delete failed: $out"
[[ "$out" != *"volume outpost-node-data: already gone"* ]] || fail "do: a 503 was taken as already gone"
[[ "$out" != *"Billing for these resources has stopped"* ]] || fail "do: destroy claimed billing stopped"
[ -f "$OUTPOST_STATE_DIR/state" ] || fail "do: destroy forgot the server after a 503"
ls "$FAKE_STATE"/volume.* >/dev/null 2>&1 || fail "do: volume gone?"
rm -f "$FAKE_STATE/volume-503"
"$ROOT/outpost" destroy --yes >/dev/null
[ "$(find "$FAKE_STATE" -type f ! -name calls.log | wc -l)" -eq 0 ] || fail "do: retry after a 503 left resources"
echo "ok: do destroy with volume get/delete failing (503) fails and keeps the state"

# The network drops right after the droplet is deleted: same, nothing else may be called gone.
find "$FAKE_STATE" -type f -delete
"$ROOT/outpost" provision --provider "do" --yes --no-wait >/dev/null
: >"$FAKE_STATE/drop-after-droplet-delete"
out="$("$ROOT/outpost" destroy --yes 2>&1)" && fail "do: destroy succeeded after the network dropped: $out"
[[ "$out" != *"already gone"* ]] || fail "do: called something gone with no network: $out"
[ -f "$OUTPOST_STATE_DIR/state" ] || fail "do: destroy forgot the server after the network dropped"
rm -f "$FAKE_STATE/drop-after-droplet-delete" "$FAKE_STATE/api-down"
"$ROOT/outpost" destroy --yes >/dev/null
[ "$(find "$FAKE_STATE" -type f ! -name calls.log | wc -l)" -eq 0 ] || fail "do: retry after the network dropped left resources"
echo "ok: do destroy with the network dropping midway fails and keeps the state"

# Disk defaults: new Hetzner accounts can hold at most 1024 GB of volumes.
find "$FAKE_STATE" -type f -delete
"$ROOT/outpost" provision --provider hetzner --yes --no-wait >/dev/null
grep -q "hcloud volume create .*--size 1000 " "$FAKE_STATE/calls.log" || fail "hetzner: default volume is not 1000 GB"
"$ROOT/outpost" destroy --yes >/dev/null
"$ROOT/outpost" provision --provider "do" --yes --no-wait >/dev/null
grep -q "doctl compute volume create .*--size 1200GiB" "$FAKE_STATE/calls.log" || fail "do: default volume is not 1200 GiB"
"$ROOT/outpost" destroy --yes >/dev/null
! "$ROOT/outpost" provision --provider hetzner --disk 900 --yes --no-wait >/dev/null 2>&1 || fail "--disk 900 accepted"
out="$("$ROOT/outpost" provision --provider hetzner --disk 1200 --dry-run 2>&1)"
[[ "$out" == *"at most 1024 GB"* ]] || fail "hetzner: no warning for a volume over 1024 GB"
echo "ok: default disk 1000 GB on Hetzner, 1200 GB on DigitalOcean"

# No network: destroy must fail and keep the state, never call the resources gone.
for p in "do" hetzner; do
  find "$FAKE_STATE" -type f -delete
  "$ROOT/outpost" provision --provider "$p" --yes --no-wait >/dev/null
  : >"$FAKE_STATE/api-down"
  ! "$ROOT/outpost" destroy --yes >/dev/null 2>&1 || fail "$p: destroy succeeded with the API down"
  [ -f "$OUTPOST_STATE_DIR/state" ] || fail "$p: destroy forgot the server with the API down"
  rm -f "$FAKE_STATE/api-down"
  "$ROOT/outpost" destroy --yes >/dev/null
  echo "ok: $p destroy with the API down fails and keeps the state"
done
find "$WORK" -type f -delete
