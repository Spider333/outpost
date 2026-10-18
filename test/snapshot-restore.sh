#!/usr/bin/env bash
# Tests infra/snapshot-restore.sh against a fake snapshot bucket on 127.0.0.1 (Linux only: the
# script targets Ubuntu servers). Checks: a clean load matches the source byte for byte, a rerun
# skips loaded shards, a missing chunk fails without leaving a half shard in .rocks, and the next
# run resumes and finishes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
PORT="${PORT:-18999}"
fail() { echo "FAIL: $*"; tail -20 "$T/log" 2>/dev/null; exit 1; }

# Fake source data: shard-1 (30 files of 1 MB) and shard-0 (3 files).
mkdir -p "$T/src/shard-1" "$T/src/shard-0" "$T/bucket"
for i in $(seq 1 30); do head -c 1048576 /dev/urandom >"$T/src/shard-1/$i.sst"; done
for i in 1 2 3; do head -c 200000 /dev/urandom >"$T/src/shard-0/$i.sst"; done

# Publish each shard the way the real bucket does: a tar split into 1 MB pieces, each gzipped,
# plus <network>/<shard>/latest.json listing them.
for s in 1 0; do
  kb="FARCASTER_NETWORK_MAINNET/$s/snapshot-test.tar.gz"
  mkdir -p "$T/bucket/$kb" "$T/bucket/FARCASTER_NETWORK_MAINNET/$s"
  (cd "$T/src" && tar -cf - "shard-$s") | split -b 1048576 -a 4 -d - "$T/bucket/$kb/raw_"
  n=0
  for f in "$T/bucket/$kb"/raw_*; do
    n=$((n + 1))
    gzip -c "$f" >"$T/bucket/$kb/$(printf 'chunk_%04d.bin' "$n")"
    rm -f "$f"
  done
  jq -n --arg kb "$kb" --argjson n "$n" '{key_base: $kb, chunks: [range(1; $n + 1) | "chunk_\(. | tostring | ("000" + .)[-4:]).bin"]}' \
    >"$T/bucket/FARCASTER_NETWORK_MAINNET/$s/latest.json"
done

(cd "$T/bucket" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
srv=$!
trap 'kill "$srv" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.1; done

# shellcheck disable=SC2016 # expanded when the fake setup runs
printf '#!/bin/sh\necho "setup ran with KIT_DATA_DIR=$KIT_DATA_DIR KIT_FROM_RESTORE=$KIT_FROM_RESTORE" >>"%s/setup.log"\n' "$T" >"$T/fake-setup.sh"
run() {
  KIT_SNAPSHOT_URL="http://127.0.0.1:$PORT" KIT_SHARDS="1 0" KIT_DOWNLOAD_JOBS=4 \
    KIT_STATE="$T/state" KIT_RESTORE_LOG="$T/log" KIT_SETUP="$T/fake-setup.sh" \
    bash "$ROOT/infra/snapshot-restore.sh" "$T/data/snapchain"
}

# 1. Clean load.
run || fail "clean load exited non-zero"
for s in 1 0; do diff -r "$T/src/shard-$s" "$T/data/snapchain/.rocks/shard-$s" >/dev/null || fail "shard $s differs from the source"; done
[ ! -e "$T/data/snapchain/.restore" ] || fail ".restore left behind"
grep -q "^done: snapshot loaded" "$T/state/restore.progress" || fail "progress does not say done"
grep -q "KIT_DATA_DIR=$T/data KIT_FROM_RESTORE=1" "$T/setup.log" || fail "node setup not started with the right data dir"
echo "ok: clean load matches the source, node setup started"

# 2. Rerun skips loaded shards.
run || fail "rerun exited non-zero"
grep -q "shard 1: already loaded" "$T/log" || fail "rerun did not skip shard 1"
echo "ok: rerun skips loaded shards"

# 3. A chunk that cannot be downloaded: fails, and leaves no half shard in .rocks.
mv "$T/data" "$T/data.first"
kb1="$T/bucket/FARCASTER_NETWORK_MAINNET/1/snapshot-test.tar.gz"
mv "$kb1/chunk_0010.bin" "$T/chunk_0010.bin"
if run; then fail "load with a missing chunk succeeded"; fi
[ ! -e "$T/data/snapchain/.rocks/shard-1" ] || fail "a half-loaded shard 1 was moved into .rocks"
grep -q "^failed" "$T/state/restore.progress" || fail "progress does not say failed"
echo "ok: missing chunk fails cleanly, nothing half-loaded in .rocks"

# 4. Chunk back: the next run resumes and finishes.
mv "$T/chunk_0010.bin" "$kb1/chunk_0010.bin"
run || fail "resume exited non-zero"
for s in 1 0; do diff -r "$T/src/shard-$s" "$T/data/snapchain/.rocks/shard-$s" >/dev/null || fail "shard $s differs after resume"; done
echo "ok: resume finishes and matches the source"

find "$T" -delete
