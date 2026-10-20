#!/usr/bin/env bash
# Runs the watchdog against fake doctl and a fake ssh, with a one-second "hour". Checks it
# deletes at the time limit and when progress stops, and leaves the server alone while
# progress moves, while SSH is down, before the node has started, once synced, and after
# watchdog stop. Also checks it exits after a manual destroy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
export FAKE_STATE="$WORK/provider" OUTPOST_STATE_DIR="$WORK/outpost"
export PATH="$ROOT/test/fake-ssh:$ROOT/test/fake-providers:$PATH"
export OUTPOST_HOUR_SECS=1 OUTPOST_WATCHDOG_INTERVAL=1 OUTPOST_SSH_CHECK_SECS=2
mkdir -p "$FAKE_STATE"
ssh-keygen -q -t ed25519 -N "" -f "$WORK/key"
export OUTPOST_SSH_KEY="$WORK/key"
OP="$ROOT/outpost"
fail() { echo "FAIL: $*"; exit 1; }
wd_pid() { cat "$OUTPOST_STATE_DIR/watchdog.pid" 2>/dev/null || true; }
cleanup() {
  local pid
  pid="$(wd_pid)"
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  find "$WORK" -type f -delete 2>/dev/null || true
}
trap cleanup EXIT

server_exists() { [ -e "$FAKE_STATE/droplet.outpost-node" ] || [ -e "$FAKE_STATE/hz.server.outpost-node" ]; }
gone_within() { for _ in $(seq 1 "$1"); do server_exists || return 0; sleep 1; done; return 1; }
# A new server (provider $3, default DigitalOcean) with the watchdog armed for $1 "hours",
# reporting progress line $2.
start() {
  find "$FAKE_STATE" -type f -delete
  rm -f "$OUTPOST_STATE_DIR/watchdog.log"
  echo "$2" >"$FAKE_STATE/progress"
  "$OP" provision --provider "${3:-do}" --yes --no-wait --watchdog "$1" >/dev/null
  server_exists || fail "provision made no server"
}
finish() {
  "$OP" destroy --yes >/dev/null
  for _ in 1 2 3 4 5; do kill -0 "$(wd_pid)" 2>/dev/null || return 0; sleep 1; done
  fail "$1: watchdog still running after destroy"
}

# 1. Time limit. Before ./outpost node has run there is no stall, only the time limit.
start 6 "node container is not running"
out="$("$OP" status)"
[[ "$out" == *"watchdog: deletes the server at"* ]] || fail "status does not show the watchdog: $out"
sleep 4
server_exists || fail "deleted before the time limit (no node yet is not a stall)"
gone_within 8 || fail "not deleted at the time limit"
# The droplet goes first; wait for the watchdog to finish the rest before counting.
for _ in 1 2 3 4 5; do kill -0 "$(wd_pid)" 2>/dev/null || break; sleep 1; done
[ "$(find "$FAKE_STATE" -type f ! -name calls.log ! -name progress | wc -l)" -eq 0 ] || fail "time limit: resources left"
grep -q "time limit reached" "$OUTPOST_STATE_DIR/watchdog.log" || fail "time limit: no log line"
echo "ok: deletes at the time limit, not before"

# 2. Stall: the same progress line for 2 "hours".
start 100 "catching up: furthest shard is 500 blocks behind"
gone_within 10 || fail "not deleted after no progress"
grep -q "no progress for 2 hours" "$OUTPOST_STATE_DIR/watchdog.log" || fail "stall: no log line"
echo "ok: deletes when progress stops"

# 3. A node that stops after it has started counts as a stall too.
start 100 "loading snapshot: shard 1: 25 of 2672 chunks loaded, 2 GB on disk"
sleep 2
echo "node container is not running" >"$FAKE_STATE/progress"
gone_within 10 || fail "not deleted after the node stopped"
echo "ok: deletes when the node stops"

# 4. Moving progress, then watchdog stop.
start 100 "catching up: furthest shard is 9000 blocks behind"
for i in $(seq 1 16); do echo "catching up: furthest shard is $((9000 - i)) blocks behind" >"$FAKE_STATE/progress"; sleep 0.5; done
server_exists || fail "deleted while progress was moving"
pid="$(wd_pid)"
out="$("$OP" watchdog stop)"
[[ "$out" == *"watchdog off"* ]] || fail "watchdog stop said: $out"
sleep 1
! kill -0 "$pid" 2>/dev/null || fail "watchdog still running after stop"
[[ "$("$OP" status)" == *"watchdog: off"* ]] || fail "status does not show watchdog off"
echo "catching up: furthest shard is 9000 blocks behind" >"$FAKE_STATE/progress"
sleep 4
server_exists || fail "deleted after watchdog stop"
"$OP" destroy --yes >/dev/null
echo "ok: leaves a moving node alone; watchdog stop keeps the server"

# 5. SSH down, after the node has started, for longer than the stall limit is not a stall;
# progress after it comes back keeps the server; a manual destroy ends the watchdog.
start 100 "catching up: furthest shard is 500 blocks behind"
"$OP" watchdog start --hours 100 --stall-hours 4 >/dev/null
sleep 2
: >"$FAKE_STATE/ssh-down"
sleep 6
server_exists || fail "deleted while SSH was down"
echo "catching up: furthest shard is 400 blocks behind" >"$FAKE_STATE/progress"
rm -f "$FAKE_STATE/ssh-down"
sleep 2
server_exists || fail "deleted right after SSH came back with new progress"
finish "ssh down"
echo "ok: SSH down is not a stall; manual destroy ends the watchdog"

# 6. A synced node is never stalled.
start 100 "synced: every shard is within 0 blocks of the tip"
sleep 5
server_exists || fail "deleted a synced node"
finish synced
echo "ok: leaves a synced node alone"

# 7. Phases with no progress signal (Snapchain's own loader, the node opening its database)
# are not stalls.
start 100 "loading snapshot: shard 2: 2672 of 2672 chunks loaded, 560 GB on disk"
sleep 2
echo "loading snapshot into the database (no API yet)" >"$FAKE_STATE/progress"
sleep 5
server_exists || fail "deleted while the node was opening its database"
finish "no API yet"
echo "ok: phases with no progress signal are not stalls"

# 8. The time limit passes while the provider's API is unreachable (Hetzner and DigitalOcean):
# the watchdog keeps the state and retries until the deletion really happens.
for p in hetzner "do"; do
  start 3 "catching up: furthest shard is 500 blocks behind" "$p"
  : >"$FAKE_STATE/api-down"
  sleep 6
  server_exists || fail "$p: server gone with the API down?"
  [ -f "$OUTPOST_STATE_DIR/state" ] || fail "$p: watchdog forgot the server while the API was down"
  kill -0 "$(wd_pid)" 2>/dev/null || fail "$p: watchdog gave up while the API was down"
  rm -f "$FAKE_STATE/api-down"
  gone_within 8 || fail "$p: not deleted once the API was back"
  echo "ok: $p, time limit during an API outage: retries until deleted"
done

# 8b. DigitalOcean answers 503 for volume get and delete only: the watchdog must keep the state
# and retry until the volume is really deleted.
start 3 "catching up: furthest shard is 500 blocks behind"
: >"$FAKE_STATE/volume-503"
sleep 6
ls "$FAKE_STATE"/volume.* >/dev/null 2>&1 || fail "volume gone while its delete failed?"
[ -f "$OUTPOST_STATE_DIR/state" ] || fail "watchdog forgot the server while volume delete failed"
kill -0 "$(wd_pid)" 2>/dev/null || fail "watchdog gave up while volume delete failed"
rm -f "$FAKE_STATE/volume-503"
for _ in $(seq 1 8); do ls "$FAKE_STATE"/volume.* >/dev/null 2>&1 || break; sleep 1; done
! ls "$FAKE_STATE"/volume.* >/dev/null 2>&1 || fail "volume not deleted once the API was back"
for _ in 1 2 3 4 5; do kill -0 "$(wd_pid)" 2>/dev/null || break; sleep 1; done
! kill -0 "$(wd_pid)" 2>/dev/null || fail "watchdog still running after the volume was deleted"
echo "ok: do, volume delete failing (503): retries until the volume is deleted"

# 8c. A stall-triggered delete fails after the server is gone (volume answers 503): the
# watchdog retries at once, not only at the time limit.
start 100 "catching up: furthest shard is 500 blocks behind"
: >"$FAKE_STATE/volume-503"
for _ in $(seq 1 10); do server_exists || break; sleep 1; done
! server_exists || fail "stall: server not deleted"
sleep 3
rm -f "$FAKE_STATE/volume-503"
for _ in $(seq 1 8); do ls "$FAKE_STATE"/volume.* >/dev/null 2>&1 || break; sleep 1; done
! ls "$FAKE_STATE"/volume.* >/dev/null 2>&1 || fail "stall: leftover volume not retried before the time limit"
echo "ok: a failed stall delete is retried until done"

# 8d. A progress check that hangs on the server does not block the time limit.
start 3 "catching up: furthest shard is 500 blocks behind"
: >"$FAKE_STATE/ssh-hang"
gone_within 12 || fail "not deleted at the time limit while the progress check hung"
rm -f "$FAKE_STATE/ssh-hang"
echo "ok: a hung progress check does not block the time limit"

# 9b. A watchdog of another checkout is not killed by stop: one at another path, and one at a
# path that ends with this checkout's path. The stand-in stays a bash process (no exec), like
# a real watchdog, and holds no long-lived child.
for dir in "$WORK/other" "$WORK/nest$ROOT"; do
  mkdir -p "$dir"
  printf '#!/usr/bin/env bash\nwhile :; do sleep 1; done\n' >"$dir/outpost"
  chmod +x "$dir/outpost"
  "$dir/outpost" watchdog run &
  other=$!
  echo "$other" >"$OUTPOST_STATE_DIR/watchdog.pid"
  "$OP" watchdog stop >/dev/null
  kill -0 "$other" 2>/dev/null || fail "watchdog stop killed the watchdog of $dir"
  kill "$other"; wait "$other" 2>/dev/null || true
done
echo "ok: another checkout's watchdog is not killed"

# 9. A saved pid that now belongs to another program (after a restart) is left alone.
sleep 1000 &
other=$!
echo "$other" >"$OUTPOST_STATE_DIR/watchdog.pid"
"$OP" watchdog stop >/dev/null
kill -0 "$other" 2>/dev/null || fail "watchdog stop killed an unrelated process"
kill "$other"
wait "$other" 2>/dev/null || true
echo "ok: a stale pid of another program is not killed"

# 10. Bad values and servers Outpost did not make are refused before anything is created.
find "$FAKE_STATE" -type f -delete
! "$OP" provision --provider "do" --yes --no-wait --watchdog 0 >/dev/null 2>&1 || fail "--watchdog 0 accepted"
! server_exists || fail "--watchdog 0 still created a server"
! OUTPOST_HOST=192.0.2.1 "$OP" watchdog start >/dev/null 2>&1 || fail "watchdog started for an OUTPOST_HOST server"
echo "ok: refuses bad hours and servers it did not make"

# 11. Hours are decimal (08 is 8, 0024 is 24), and anything over 720 or too long is refused
# before a server exists.
for bad in 721 99999999999999999999 1e3 -5 8.5; do
  find "$FAKE_STATE" -type f -delete
  ! "$OP" provision --provider "do" --yes --no-wait --watchdog "$bad" >/dev/null 2>&1 || fail "--watchdog $bad accepted"
  ! server_exists || fail "--watchdog $bad still created a server"
done
for h in 08 0024; do
  start "$h" "node container is not running"
  left=$(( $(grep '^WATCHDOG_DEADLINE=' "$OUTPOST_STATE_DIR/state" | cut -d= -f2) - $(date +%s) ))
  want=$((10#$h))
  if [ "$left" -lt $((want - 2)) ] || [ "$left" -gt "$want" ]; then fail "--watchdog $h set $left hours, not $want"; fi
  kill -0 "$(wd_pid)" 2>/dev/null || fail "--watchdog $h: watchdog not running"
  finish "--watchdog $h"
done
start 100 "node container is not running"
"$OP" watchdog start --hours 09 --stall-hours 03 >/dev/null || fail "watchdog start --hours 09 failed"
grep -qx 'WATCHDOG_STALL_HOURS=3' "$OUTPOST_STATE_DIR/state" || fail "--stall-hours 03 not stored as 3"
finish "watchdog start --hours 09"
echo "ok: hours with leading zeros are decimal; huge or out-of-range hours are refused first"

# 12. Stop while the watchdog is already deleting says so, and the delete still finishes.
export FAKE_DELETE_SECS=4
start 1 "node container is not running"
for _ in $(seq 1 10); do grep -q "deleting the server" "$OUTPOST_STATE_DIR/watchdog.log" 2>/dev/null && break; sleep 1; done
grep -q "deleting the server" "$OUTPOST_STATE_DIR/watchdog.log" || fail "stop during delete: the delete never started"
out="$("$OP" watchdog stop)"
[[ "$out" == *"already started deleting"* && "$out" != *"the server stays"* ]] || fail "stop during delete said: $out"
unset FAKE_DELETE_SECS
gone_within 10 || fail "stop during delete: the delete did not finish"
echo "ok: stop during a delete says the delete carries on"
