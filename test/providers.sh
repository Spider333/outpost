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
  grep -qx "		exclude http.log http.handlers http.stdlib tls.handshake" "$SRV/caddy/Caddyfile" || fail "$p: Caddyfile lets Caddy log request URIs and client IPs"
  # All of it: no request logs, a proxy to the gate on $host, nothing else (no files, no page).
  want="$(printf '{\n\tlog {\n\t\texclude http.log http.handlers http.stdlib tls.handshake\n\t}\n}\n%s {\n\treverse_proxy 127.0.0.1:3390\n\theader -Server\n}' "$host")"
  [ "$(cat "$SRV/caddy/Caddyfile")" = "$want" ] || fail "$p: Caddyfile is not exactly the society one:
$(cat "$SRV/caddy/Caddyfile")"
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

# Server size: provision makes the server small, node sizes it up for the first sync, shrink
# takes it back down once the node is synced. Only CPU and RAM change, so the disk stays small
# enough for the server to go back down.
STATE="$OUTPOST_STATE_DIR/state"
resizes() { grep -E "droplet-action|server (shutdown|poweroff|poweron|change-type)" "$FAKE_STATE/calls.log" || true; }
for p in "do" hetzner; do
  find "$FAKE_STATE" -type f -delete
  if [ "$p" = "do" ]; then small=s-2vcpu-8gb-amd big=s-8vcpu-32gb-amd; else small=ccx13 big=ccx33; fi
  # Prints "<size> <on|off>" for the one server.
  server() {
    if [ "$p" = "do" ]; then awk '{print $4, ($5 == "off" ? "off" : "on")}' "$FAKE_STATE"/droplet.*
    else awk '{print $1, ($2 == "off" ? "off" : "on")}' "$FAKE_STATE"/hz.server.*; fi
  }
  set_off() {
    local f
    if [ "$p" = "do" ]; then f="$(echo "$FAKE_STATE"/droplet.*)"; awk '{$5="off"; print}' "$f" >"$f.new"
    else f="$(echo "$FAKE_STATE"/hz.server.*)"; awk '{$2="off"; print}' "$f" >"$f.new"; fi
    mv "$f.new" "$f"
  }
  "$ROOT/outpost" provision --provider "$p" --yes --no-wait >/dev/null
  [ "$(server)" = "$small on" ] || fail "$p: provision did not make the server $small: $(server)"
  mkdir -p "$FAKE_STATE/server"
  : >"$FAKE_STATE/server/outpost-ready"
  echo "node container is not running" >"$FAKE_STATE/node-line"
  : >"$FAKE_STATE/calls.log"
  out="$("$ROOT/outpost" shrink --yes 2>&1)" || fail "$p: shrink before node failed: $out"
  [[ "$out" == *"./outpost node sizes it up"* ]] || fail "$p: shrink before node: $out"
  [ -z "$(resizes)" ] || fail "$p: shrink touched a server that was never sized up"

  "$ROOT/outpost" node --no-wait >/dev/null || fail "$p: node failed"
  [ "$(server)" = "$big on" ] || fail "$p: node did not size the server up to $big and start it: $(server)"
  if [ "$p" = "do" ]; then
    grep -q "droplet-action shutdown d-1 --wait" "$FAKE_STATE/calls.log" || fail "do: no clean shutdown before the resize"
    [ ! -e "$FAKE_STATE/disk-resized" ] || fail "do: the resize grew the disk, so the droplet can never shrink"
  else
    grep -q "hcloud server shutdown outpost-node" "$FAKE_STATE/calls.log" || fail "hetzner: no clean shutdown before the resize"
    grep -q "server change-type --keep-disk outpost-node $big" "$FAKE_STATE/calls.log" || fail "hetzner: resize without --keep-disk"
  fi
  : >"$FAKE_STATE/calls.log"
  "$ROOT/outpost" node --no-wait >/dev/null || fail "$p: node twice failed"
  [ -z "$(resizes)" ] || fail "$p: node twice resized again: $(resizes)"

  echo "catching up: furthest shard is 5000 blocks behind" >"$FAKE_STATE/node-line"
  : >"$FAKE_STATE/calls.log"
  out="$("$ROOT/outpost" shrink --yes 2>&1)" && fail "$p: shrink ran before the node was synced: $out"
  [[ "$out" == *"not synced yet"* ]] || fail "$p: shrink before sync said: $out"
  [ -z "$(resizes)" ] || fail "$p: shrink before sync touched the server"

  echo "synced: every shard is within 2 blocks of the tip" >"$FAKE_STATE/node-line"
  out="$("$ROOT/outpost" status)"
  [[ "$out" == *"./outpost shrink moves it to $small"* ]] || fail "$p: status does not point to shrink: $out"
  : >"$FAKE_STATE/calls.log"
  out="$("$ROOT/outpost" shrink --dry-run 2>&1)" || fail "$p: shrink --dry-run failed: $out"
  if [ "$p" = "do" ]; then want="droplet-action resize"; else want="change-type --keep-disk outpost-node $small"; fi
  [[ "$out" == *"$want"* && "$out" == *"$small"* ]] || fail "$p: shrink --dry-run did not show the resize: $out"
  if [ "$(server)" != "$big on" ] || [ -n "$(resizes)" ]; then fail "$p: shrink --dry-run changed the server"; fi
  ! grep -qx "SHRUNK=1" "$STATE" || fail "$p: shrink --dry-run marked the server shrunk"

  # Stopped after the shutdown, before the resize: the server is off, so the node cannot say it
  # is synced. A second shrink finishes the job without asking it (an answer other than synced
  # would make it refuse).
  echo "SHRUNK=1" >>"$STATE"
  set_off
  echo "catching up: furthest shard is 5000 blocks behind" >"$FAKE_STATE/node-line"
  out="$("$ROOT/outpost" shrink --yes 2>&1)" || fail "$p: shrink after one stopped halfway failed: $out"
  [ "$(server)" = "$small on" ] || fail "$p: shrink after one stopped halfway: $(server)"
  "$ROOT/outpost" node --no-wait >/dev/null || fail "$p: node after an interrupted shrink failed"
  [ "$(server)" = "$small on" ] || fail "$p: node sized up a server whose shrink was interrupted"
  # Back to big and synced, for the plain run below.
  grep -v '^SHRUNK=' "$STATE" >"$STATE.new" && mv "$STATE.new" "$STATE"
  "$ROOT/outpost" node --no-wait >/dev/null || fail "$p: node to size up again failed"
  [ "$(server)" = "$big on" ] || fail "$p: node did not size up again: $(server)"
  echo "synced: every shard is within 2 blocks of the tip" >"$FAKE_STATE/node-line"

  : >"$FAKE_STATE/calls.log"
  out="$("$ROOT/outpost" shrink --yes 2>&1)" || fail "$p: shrink failed: $out"
  [ "$(server)" = "$small on" ] || fail "$p: shrink did not move the server to $small and start it: $(server)"
  [[ "$out" == *"node: synced"* ]] || fail "$p: shrink did not report the node afterwards: $out"
  [ "$p" = hetzner ] || [[ "$out" == *"from \$168.00 to \$42.00 a month"* ]] || fail "do: shrink did not show the price: $out"
  [ ! -e "$FAKE_STATE/disk-resized" ] || fail "$p: shrink resized the disk"
  ! grep -qE " (create|delete) " "$FAKE_STATE/calls.log" || fail "$p: shrink created or deleted something"
  grep -qx "SHRUNK=1" "$STATE" || fail "$p: shrink did not record it"
  : >"$FAKE_STATE/calls.log"
  out="$("$ROOT/outpost" shrink --yes 2>&1)" || fail "$p: shrink twice failed: $out"
  if [[ "$out" != *"already $small"* ]] || [ -n "$(resizes)" ]; then fail "$p: shrink twice: $out"; fi
  # Stopped after the resize, before the server was started again: shrink starts it.
  set_off
  out="$("$ROOT/outpost" shrink --yes 2>&1)" || fail "$p: shrink of a small server left off failed: $out"
  [ "$(server)" = "$small on" ] || fail "$p: shrink left a small server off: $(server)"
  : >"$FAKE_STATE/calls.log"
  "$ROOT/outpost" node --no-wait >/dev/null || fail "$p: node after shrink failed"
  if [ "$(server)" != "$small on" ] || [ -n "$(resizes)" ]; then fail "$p: node sized a shrunk server up again"; fi
  [[ "$("$ROOT/outpost" status)" != *"./outpost shrink"* ]] || fail "$p: status still points to shrink"
  "$ROOT/outpost" destroy --yes >/dev/null
  echo "ok: $p provision small, node sizes up once, shrink only once synced, twice is a no-op"
done

# A resize the provider refuses (here: a droplet made at full size, whose disk is bigger than the
# small plan's) leaves the server running on its old plan.
find "$FAKE_STATE" -type f -delete
"$ROOT/outpost" provision --provider "do" --size s-8vcpu-32gb-amd --small-size s-8vcpu-32gb-amd --yes --no-wait >/dev/null
grep -v '^SMALL_SIZE=' "$STATE" >"$STATE.new" && echo "SMALL_SIZE=s-2vcpu-8gb-amd" >>"$STATE.new" && mv "$STATE.new" "$STATE"
mkdir -p "$FAKE_STATE/server"
: >"$FAKE_STATE/server/outpost-ready"
echo "synced: every shard is within 2 blocks of the tip" >"$FAKE_STATE/node-line"
out="$("$ROOT/outpost" shrink --yes 2>&1)" && fail "do: shrink succeeded where the provider refused: $out"
[[ "$out" == *"could not move outpost-node to s-2vcpu-8gb-amd"* ]] || fail "do: refused resize said: $out"
[ "$(awk '{print $4, $5}' "$FAKE_STATE"/droplet.*)" = "s-8vcpu-32gb-amd active" ] || fail "do: refused resize left the droplet off or changed"
! grep -qx "SHRUNK=1" "$STATE" || fail "do: a refused shrink still counts as shrunk"
[[ "$("$ROOT/outpost" status)" == *"./outpost shrink moves it to"* ]] || fail "do: status stopped pointing to shrink after a refused one"
"$ROOT/outpost" destroy --yes >/dev/null
echo "ok: do shrink the provider refuses starts the server again on its old plan"

# Servers shrink must not touch: one Outpost found already there, and one given by OUTPOST_HOST.
find "$FAKE_STATE" -type f -delete
"$ROOT/outpost" provision --provider "do" --yes --no-wait >/dev/null
echo "d-2 legacy 203.0.113.8 s-8vcpu-32gb-amd active 400" >"$FAKE_STATE/droplet.legacy"
"$ROOT/outpost" provision --provider "do" --name legacy --yes --no-wait >/dev/null
echo "synced: every shard is within 2 blocks of the tip" >"$FAKE_STATE/node-line"
: >"$FAKE_STATE/calls.log"
out="$("$ROOT/outpost" shrink --yes 2>&1)" && fail "do: shrink ran on a server Outpost did not make small: $out"
[[ "$out" == *"was not made small"* ]] || fail "do: shrink on a found server said: $out"
out="$(OUTPOST_HOST=192.0.2.1 "$ROOT/outpost" shrink --yes 2>&1)" && fail "shrink ran with OUTPOST_HOST: $out"
[[ "$out" == *"only resizes a server made here"* ]] || fail "shrink with OUTPOST_HOST said: $out"
[ -z "$(resizes)" ] || fail "do: a refused shrink touched a server"
rm -f "$FAKE_STATE/droplet.legacy"
"$ROOT/outpost" destroy --name outpost-node --yes >/dev/null
echo "ok: shrink leaves alone servers it did not make small"

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
