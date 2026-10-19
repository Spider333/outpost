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
export OUTPOST_HOUR_SECS=1 OUTPOST_WATCHDOG_INTERVAL=1
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
sleep 2
: >"$FAKE_STATE/ssh-down"
sleep 5
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
