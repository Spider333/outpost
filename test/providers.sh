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

# Society mode. The fake ssh runs the server side (infra/society.sh) in $FAKE_STATE/server with
# a fake docker, so the Caddyfile, the gate source and the members file are real files.
SRV="$FAKE_STATE/server/srv/outpost-society"
C="$FAKE_STATE/containers"
for p in "do" hetzner; do
  find "$FAKE_STATE" -type f -delete
  "$ROOT/outpost" provision --provider "$p" --yes --no-wait >/dev/null
  if [ "$p" = "do" ]; then fw="$FAKE_STATE/fw443"; host=203-0-113-7.sslip.io; else fw="$FAKE_STATE/hz.fw443"; host=198-51-100-9.sslip.io; fi
  for run in 1 2; do
    out="$(OUTPOST_GATE_READ_RATE=50 "$ROOT/outpost" society on)" || fail "$p: society on failed (run $run)"
    [[ "$out" == *"society node: https://$host"* ]] || fail "$p: society on did not print the node URL"
  done
  [ -e "$fw" ] || fail "$p: society on did not open 443/tcp"
  [ -e "$C/outpost-society" ] || fail "$p: society on did not start Caddy"
  [ -e "$C/outpost-gate" ] || fail "$p: society on did not start the gate"
  grep -qx "$host {" "$SRV/caddy/Caddyfile" || fail "$p: Caddyfile is not for $host"
  grep -qx "	reverse_proxy 127.0.0.1:3390" "$SRV/caddy/Caddyfile" || fail "$p: Caddyfile does not proxy to the gate"
  [ "$(wc -l <"$SRV/caddy/Caddyfile")" -eq 4 ] || fail "$p: Caddyfile does more than proxy to the gate"
  cmp -s "$SRV/gate/gate.ts" "$ROOT/src/server/gate.ts" || fail "$p: the gate on the server is not src/server/gate.ts"
  grep -q -- "--network host --read-only --cap-drop ALL --security-opt no-new-privileges" "$C/outpost-gate" || fail "$p: gate container not locked down"
  grep -q -- "-v $SRV/gate:/gate:ro node:24.21.0-alpine node /gate/gate.ts" "$C/outpost-gate" || fail "$p: gate not run from its source in the pinned Node image"
  grep -qx "OUTPOST_GATE_READ_RATE=50" "$C/outpost-gate" || fail "$p: rate limit not passed to the gate"
  [ -n "$(find "$SRV/gate/members" -perm 600)" ] || fail "$p: members file is not mode 600"
  for run in 1 2; do "$ROOT/outpost" society off >/dev/null || fail "$p: society off failed (run $run)"; done
  [ ! -e "$C/outpost-society" ] || fail "$p: society off left Caddy running"
  [ ! -e "$C/outpost-gate" ] || fail "$p: society off left the gate running"
  [ ! -e "$fw" ] || fail "$p: society off did not close 443/tcp"
  [ -f "$SRV/gate/members" ] || fail "$p: society off deleted the members file"
  "$ROOT/outpost" destroy --yes >/dev/null
  echo "ok: $p society on x2, off x2"
done

find "$FAKE_STATE" -type f -delete
"$ROOT/outpost" provision --provider "do" --yes --no-wait >/dev/null
: >"$FAKE_STATE/calls.log"
! OUTPOST_GATE_READ_RATE='1;touch x' "$ROOT/outpost" society on >/dev/null 2>&1 || fail "society on accepted a rate limit that is not a number"
[ ! -s "$FAKE_STATE/calls.log" ] || fail "society on reached the server with a bad rate limit"
"$ROOT/outpost" society on >/dev/null

# Members: the token is made locally; only its SHA-256 reaches the server.
: >"$FAKE_STATE/calls.log"
out="$("$ROOT/outpost" members add alice)"
link_re='^https://spider333\.github\.io/outpost/app/#node=https%3A%2F%2F203-0-113-7\.sslip\.io&token=([0-9a-f]{64})$'
link="$(printf '%s\n' "$out" | grep '^https://' || true)"
[[ "$link" =~ $link_re ]] || fail "members add: no invite link in: $out"
token="${BASH_REMATCH[1]}"
hash="$(printf '%s' "$token" | openssl dgst -sha256 | awk '{print $NF}')"
grep -qx "alice $hash" "$SRV/gate/members" || fail "members add: members file does not hold the token's hash"
! grep -rqF "$token" "$WORK" || fail "members add: the token was stored or sent somewhere (server, command line or local state)"
grep -qx "docker kill -s HUP outpost-gate" "$FAKE_STATE/calls.log" || fail "members add: the gate was not told to reload"
cp "$SRV/gate/members" "$WORK/members.before"
out="$("$ROOT/outpost" members add alice)"
[[ "$out" == *"alice is already a member"* && "$out" != *"token="* ]] || fail "members add twice: $out"
cmp -s "$SRV/gate/members" "$WORK/members.before" || fail "members add twice changed the members file"
"$ROOT/outpost" members add bob >/dev/null
[ "$("$ROOT/outpost" members list)" = "$(printf 'alice\nbob')" ] || fail "members list"
out="$("$ROOT/outpost" society status)"
[[ "$out" == *"outpost-gate: running"* && "$out" == *"members: 2"* ]] || fail "society status: $out"
: >"$FAKE_STATE/calls.log"
out="$("$ROOT/outpost" members remove alice)"
[[ "$out" == *"removed alice"* ]] || fail "members remove: $out"
! grep -q '^alice ' "$SRV/gate/members" || fail "members remove: alice is still in the members file"
grep -q '^bob ' "$SRV/gate/members" || fail "members remove: bob is gone too"
grep -qx "docker kill -s HUP outpost-gate" "$FAKE_STATE/calls.log" || fail "members remove: the gate was not told to reload"
out="$("$ROOT/outpost" members remove alice)" || fail "members remove twice failed"
[[ "$out" == *"alice is not a member"* ]] || fail "members remove twice: $out"
"$ROOT/outpost" members remove bob >/dev/null
[[ "$("$ROOT/outpost" members list)" == *"no members yet"* ]] || fail "members list when empty"
# Names go into a remote command line, so anything but a plain name stops before SSH.
: >"$FAKE_STATE/calls.log"
# shellcheck disable=SC2016 # the $(...) must reach outpost unexpanded
for bad in 'x y' "a'b" '$(touch pwned)' '-rf' '' "$(head -c 41 /dev/zero | tr '\0' a)"; do
  ! "$ROOT/outpost" members add "$bad" >/dev/null 2>&1 || fail "members add accepted '$bad'"
  ! "$ROOT/outpost" members remove "$bad" >/dev/null 2>&1 || fail "members remove accepted '$bad'"
done
[ ! -s "$FAKE_STATE/calls.log" ] || fail "a bad member name reached the server"
echo "ok: members add x2, list, remove x2; only the token's hash reaches the server"

# Phone access and society mode both use 443/tcp: one is refused while the other is on, and
# turning one off leaves the port open for the other.
out="$("$ROOT/outpost" client --phone off)"
[[ "$out" == *"society mode still uses 443/tcp"* ]] || fail "phone off while society is on: $out"
[ -e "$FAKE_STATE/fw443" ] || fail "phone off closed 443/tcp under society mode"
! OUTPOST_PHONE_HOST=x OUTPOST_PHONE_HASH=y OUTPOST_PHONE_DIR="$WORK/phone" PATH="$ROOT/test/fake-providers/server:$PATH" \
  bash "$ROOT/infra/phone-setup.sh" >/dev/null 2>&1 || fail "phone-setup.sh started while society mode is on"
"$ROOT/outpost" society off >/dev/null
: >"$C/outpost-phone"
: >"$FAKE_STATE/fw443"
! "$ROOT/outpost" society on >/dev/null 2>&1 || fail "society on started while phone access is on"
[ ! -e "$C/outpost-gate" ] || fail "society on started the gate while phone access is on"
out="$("$ROOT/outpost" society off)"
[[ "$out" == *"phone access still uses 443/tcp"* ]] || fail "society off while phone is on: $out"
[ -e "$FAKE_STATE/fw443" ] || fail "society off closed 443/tcp under phone access"
rm -f "$C/outpost-phone"
"$ROOT/outpost" destroy --yes >/dev/null
echo "ok: phone access and society mode keep out of each other's way"
find "$WORK" -type f -delete
