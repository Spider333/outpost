#!/usr/bin/env bash
# Loads the official mainnet snapshot into a new Snapchain read node, faster and with less disk
# than Snapchain's own loader. Run as root by node-setup.sh (as the outpost-restore unit); safe to
# run again: it resumes, and a shard that is already loaded is skipped.
#
# Snapchain's loader downloads one chunk at a time, writes each shard out as a full-size .tar,
# then unpacks it. It only loads when .rocks is empty, so an interrupted load leaves the
# missing shards empty for good. This script instead:
#   - downloads 8 chunks at a time (same files, same public bucket Snapchain uses),
#   - keeps downloaded chunks on the server's own disk when it has room, so the data volume
#     only takes the database writes, and stays at most OUTPOST_MAX_AHEAD (200) chunks ahead,
#   - streams chunks through gunzip into tar in order, deleting each one once used,
#   - unpacks each shard beside .rocks and moves it in only when it is complete,
#   - starts the node only after every shard is in.
#
# Usage: snapshot-restore.sh <snapchain dir>

set -euo pipefail

DIR="${1:?usage: snapshot-restore.sh <snapchain dir>}"
BUCKET="${OUTPOST_SNAPSHOT_URL:-https://pub-d352dd8819104a778e20d08888c5a661.r2.dev}"
NETWORK="${OUTPOST_NETWORK:-FARCASTER_NETWORK_MAINNET}"
SHARDS="${OUTPOST_SHARDS:-1 2 0}"
JOBS="${OUTPOST_DOWNLOAD_JOBS:-8}"
# 200 chunks of about 70 MB (14 GB) stay in the page cache, so the unpacking reads chunks from
# memory instead of from the disk the downloads are writing to. With 1500 ahead, on 2026-10-18,
# unpacking was held to about 40 MB/s of chunk reads.
MAX_AHEAD="${OUTPOST_MAX_AHEAD:-200}"
# The paths below can be moved for tests.
STATE="${OUTPOST_STATE:-/var/lib/outpost}"
PROGRESS="$STATE/restore.progress"
LOG="${OUTPOST_RESTORE_LOG:-/var/log/outpost-restore.log}"
SETUP="${OUTPOST_SETUP:-/usr/local/lib/outpost/node-setup.sh}"

mkdir -p "$STATE"
exec >>"$LOG" 2>&1

# Progress goes to a file that ./outpost status reads, and to the log. Never to stdout inside the
# unpack pipeline: that stream is the tar archive.
progress() {
  printf '%s\n' "$*" >"$PROGRESS.tmp" && mv "$PROGRESS.tmp" "$PROGRESS"
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2
}
trap 'progress "failed at $(date -u +%H:%M) UTC (see $LOG); downloaded chunks are kept"' ERR

unzip_cmd=(gzip -dc)
command -v pigz >/dev/null 2>&1 && unzip_cmd=(pigz -dc)

free_gb() { df -BG --output=avail "$1" | tail -1 | tr -dc '0-9'; }

# One chunk: wait until it is no more than MAX_AHEAD past the unpacking, download it to .part
# (curl -f fails on errors and short reads), then mark it ready with .ok.
fetch_one() {
  local d="$1" buf="$2" base="$3" idx="$4" c="$5" used
  [ -e "$buf/$c.ok" ] && return 0
  while :; do
    # The unpacking replaces this file atomically; anything unreadable counts as 0.
    used="$(cat "$d/consumed" 2>/dev/null || true)"
    [[ "$used" =~ ^[0-9]+$ ]] || used=0
    [ $((idx - used)) -le "$MAX_AHEAD" ] && break
    sleep 2
  done
  local _
  for _ in 1 2 3 4 5 6 7 8; do
    # Drop a connection slower than 200 kB/s for 30 s and retry: the bucket sometimes
    # throttles one connection to a crawl.
    if curl -fsS --speed-limit 200000 --speed-time 30 -o "$buf/$c.part" "$base/$c"; then
      mv "$buf/$c.part" "$buf/$c"
      : >"$buf/$c.ok"
      return 0
    fi
    sleep 5
  done
  : >"$buf/$c.failed"
  return 1
}
export -f fetch_one
export MAX_AHEAD

mkdir -p "$DIR"
cd "$DIR"
mkdir -p .rocks .restore
# Buffer on the server's own disk if it is a different disk with room for MAX_AHEAD chunks
# plus margin; otherwise next to the data.
BUFROOT="${OUTPOST_BUFFER_DIR:-}"
if [ -z "$BUFROOT" ]; then
  BUFROOT="$DIR/.restore"
  if [ "$(df --output=source /var/lib | tail -1)" != "$(df --output=source . | tail -1)" ] &&
    [ "$(free_gb /var/lib)" -ge $((MAX_AHEAD * 70 / 1000 + 40)) ]; then
    BUFROOT=/var/lib/outpost/chunks
  fi
fi
start=$(date +%s)
progress "starting: shards $SHARDS, $JOBS downloads at a time, chunks buffered in $BUFROOT"

for s in $SHARDS; do
  if [ -d ".rocks/shard-$s" ]; then
    progress "shard $s: already loaded"
    continue
  fi
  d=".restore/shard-$s"
  buf="$BUFROOT/shard-$s"
  mkdir -p "$d" "$buf"
  # Keep the first index we saw, so a resumed run asks for the same chunks.
  [ -s "$d/latest.json" ] || curl -fsS -m 60 -o "$d/latest.json" "$BUCKET/$NETWORK/$s/latest.json"
  base="$BUCKET/$(jq -r .key_base "$d/latest.json")"
  # Chunk names become file names, and this runs as root: a name like ../../etc/cron.d/x
  # must never reach curl -o. Checked in jq, on the JSON strings themselves. Drop the index
  # too, so the next run asks for a fresh one.
  if ! jq -e '.chunks | all(type == "string" and test("\\A[A-Za-z0-9_][A-Za-z0-9._-]*\\z"))' "$d/latest.json" >/dev/null; then
    rm -f "$d/latest.json"
    echo "the snapshot index for shard $s has a chunk name that is not a plain file name" >&2
    exit 1
  fi
  jq -r '.chunks[]' "$d/latest.json" >"$d/chunks"
  n=$(wc -l <"$d/chunks")
  rm -f "$buf"/*.failed "$buf"/*.part
  echo 0 >"$d/consumed"
  # tar needs the stream from chunk 1, so a half-unpacked shard from an earlier run is useless.
  [ -d "$d/unpack" ] && find "$d/unpack" -mindepth 1 -delete
  mkdir -p "$d/unpack"

  # A worker that dies for any reason leaves .failed, so the unpacking never waits forever.
  # shellcheck disable=SC2016 # expanded by the child bash
  awk '{print NR, $0}' "$d/chunks" | xargs -P "$JOBS" -n 2 bash -c '( fetch_one "$0" "$1" "$2" "$3" "$4" ) || : >"$1/$4.failed"' "$d" "$buf" "$base" &
  dl=$!

  i=0
  while read -r c; do
    while [ ! -e "$buf/$c.ok" ]; do
      if [ -e "$buf/$c.failed" ]; then
        # One more try from here before giving up.
        rm -f "$buf/$c.failed"
        fetch_one "$d" "$buf" "$base" 0 "$c" || { echo "chunk $c of shard $s could not be downloaded" >&2; exit 1; }
        continue
      fi
      if ! kill -0 "$dl" 2>/dev/null && [ ! -e "$buf/$c.ok" ]; then
        echo "downloads stopped before chunk $c of shard $s" >&2
        exit 1
      fi
      sleep 1
    done
    "${unzip_cmd[@]}" "$buf/$c"
    # Used once: delete it, and its marker, so a rerun downloads it again if it needs it.
    rm -f "$buf/$c" "$buf/$c.ok"
    i=$((i + 1))
    echo "$i" >"$d/consumed.tmp" && mv "$d/consumed.tmp" "$d/consumed"
    if [ $((i % 25)) -eq 0 ] || [ "$i" -eq "$n" ]; then
      progress "shard $s: $i of $n chunks loaded, $(df -BG --output=used . | tail -1 | tr -dc '0-9') GB on disk"
    fi
  done <"$d/chunks" | tar -x -C "$d/unpack"
  # Every chunk is unpacked and tar ended cleanly, so the shard is complete whatever the
  # download workers report (a retried chunk can leave a failed worker behind).
  wait "$dl" || true

  [ -d "$d/unpack/shard-$s" ] || { echo "the snapshot for shard $s did not contain shard-$s/" >&2; exit 1; }
  mv "$d/unpack/shard-$s" ".rocks/shard-$s"
  find "$d" -delete
  [ -e "$buf" ] && find "$buf" -delete
  progress "shard $s: loaded ($(du -sh ".rocks/shard-$s" | cut -f1))"
done

find .restore -delete
if [ "$BUFROOT" != "$DIR/.restore" ] && [ -e "$BUFROOT" ]; then find "$BUFROOT" -delete; fi
mins=$((($(date +%s) - start) / 60))
progress "snapshot loaded in $mins min; starting the node"
OUTPOST_FROM_RESTORE=1 OUTPOST_DATA_DIR="$(dirname "$DIR")" bash "$SETUP"
progress "done: snapshot loaded in $mins min, node started"
