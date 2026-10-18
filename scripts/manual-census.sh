#!/usr/bin/env bash
# Independent census count for a charter, using only curl and jq against the node's HTTP
# API (none of kit's code). Used to check `kit-client charter census`.
#   scripts/manual-census.sh examples/network-states.charter.json [days] [node-url]
set -euo pipefail
charter="$1"
days="${2:-7}"
node="${3:-${KIT_NODE_URL:-http://127.0.0.1:3381}}"
now=$(date +%s)
# Farcaster time is seconds since 2021-01-01T00:00:00Z (Unix 1609459200).
cutoff=$(( now - days * 86400 - 1609459200 ))
total=0
active=0
members=0
for fid in $(jq -r '.members[]' "$charter" | sort -un); do
  members=$((members + 1))
  n=0
  token=""
  while :; do
    page=$(curl -gsf "$node/v1/castsByFid?fid=$fid&reverse=true&pageSize=100${token:+&pageToken=$token}")
    c=$(jq --argjson cut "$cutoff" '[.messages[] | select(.data.type == "MESSAGE_TYPE_CAST_ADD" and .data.timestamp >= $cut)] | length' <<<"$page")
    n=$((n + c))
    oldest=$(jq '.messages[-1].data.timestamp // 0' <<<"$page")
    token=$(jq -r '.nextPageToken // ""' <<<"$page" | jq -sRr @uri | sed 's/%0A$//')
    if [ -z "$token" ] || [ "$oldest" -lt "$cutoff" ]; then break; fi
  done
  total=$((total + n))
  [ "$n" -gt 0 ] && active=$((active + 1))
done
echo "members $members"
echo "active $active"
echo "casts $total"
awk -v t="$total" -v d="$days" 'BEGIN { printf "casts_per_day %.1f\n", t / d }'
