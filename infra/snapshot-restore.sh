#!/usr/bin/env bash
# Loads the official mainnet snapshot into a new Snapchain read node, faster and with less disk
# than Snapchain's own loader. Run as root by node-setup.sh (as the kit-restore unit); safe to
# run again: it resumes, and a shard that is already loaded is skipped.
#
# Snapchain's loader downloads one chunk at a time, writes each shard out as a full-size .tar,
# then unpacks it. It only loads when .rocks is empty, so an interrupted load leaves the
# missing shards empty for good. This script instead:
#   - downloads 8 chunks at a time (same files, same public bucket Snapchain uses),
#   - keeps downloaded chunks on the server's own disk when it has room, so the data volume
#     only takes the database writes, and stays at most KIT_MAX_AHEAD chunks ahead,
#   - streams chunks through gunzip into tar in order, deleting each one once used,
#   - unpacks each shard beside .rocks and moves it in only when it is complete,
#   - starts the node only after every shard is in.
#
# Usage: snapshot-restore.sh <snapchain dir>

set -euo pipefail

DIR="${1:?usage: snapshot-restore.sh <snapchain dir>}"
BUCKET="${KIT_SNAPSHOT_URL:-https://pub-d352dd8819104a778e20d08888c5a661.r2.dev}"
NETWORK="${KIT_NETWORK:-FARCASTER_NETWORK_MAINNET}"
SHARDS="${KIT_SHARDS:-1 2 0}"
JOBS="${KIT_DOWNLOAD_JOBS:-8}"
# 1500 chunks of about 70 MB: at most about 105 GB waiting to be unpacked.
MAX_AHEAD="${KIT_MAX_AHEAD:-1500}"
# The paths below can be moved for tests.
STATE="${KIT_STATE:-/var/lib/kit}"
PROGRESS="$STATE/restore.progress"
LOG="${KIT_RESTORE_LOG:-/var/log/kit-restore.log}"
SETUP="${KIT_SETUP:-/usr/local/lib/kit/node-setup.sh}"

mkdir -p "$STATE"
exec >>"$LOG" 2>&1

# Progress goes to a file that ./kit status reads, and to the log. Never to stdout inside the
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
  local d="$1" buf="$2" base="$3" idx="$4" c="$5"
  [ -e "$buf/$c.ok" ] && return 0
  while [ $((idx - $(cat "$d/consumed" 2>/dev/null || echo 0))) -gt "$MAX_AHEAD" ]; do sleep 2; done
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
BUFROOT="${KIT_BUFFER_DIR:-}"
if [ -z "$BUFROOT" ]; then
  BUFROOT="$DIR/.restore"
  if [ "$(df --output=source /var/lib | tail -1)" != "$(df --output=source . | tail -1)" ] &&
    [ "$(free_gb /var/lib)" -ge $((MAX_AHEAD * 70 / 1000 + 40)) ]; then
    BUFROOT=/var/lib/kit/chunks
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
  jq -r '.chunks[]' "$d/latest.json" >"$d/chunks"
  n=$(wc -l <"$d/chunks")
  rm -f "$buf"/*.failed "$buf"/*.part
  echo 0 >"$d/consumed"
  # tar needs the stream from chunk 1, so a half-unpacked shard from an earlier run is useless.
  [ -d "$d/unpack" ] && find "$d/unpack" -mindepth 1 -delete
  mkdir -p "$d/unpack"

  # shellcheck disable=SC2016 # expanded by the child bash
  awk '{print NR, $0}' "$d/chunks" | xargs -P "$JOBS" -n 2 bash -c 'fetch_one "$0" "$1" "$2" "$3" "$4"' "$d" "$buf" "$base" &
  dl=$!

  i=0
  while read -r c; do
    while [ ! -e "$buf/$c.ok" ]; do
      [ -e "$buf/$c.failed" ] && { echo "chunk $c of shard $s could not be downloaded" >&2; exit 1; }
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
    echo "$i" >"$d/consumed"
    if [ $((i % 25)) -eq 0 ] || [ "$i" -eq "$n" ]; then
      progress "shard $s: $i of $n chunks loaded, $(df -BG --output=used . | tail -1 | tr -dc '0-9') GB on disk"
    fi
  done <"$d/chunks" | tar -x -C "$d/unpack"
  wait "$dl"

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
KIT_FROM_RESTORE=1 KIT_DATA_DIR="$(dirname "$DIR")" bash "$SETUP"
progress "done: snapshot loaded in $mins min, node started"
