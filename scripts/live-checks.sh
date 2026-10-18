#!/usr/bin/env bash
# Mainnet checks to run once the node is synced. Writes outputs to docs/evidence/live/.
#   KIT_NODE_URL=http://<node>:3381 scripts/live-checks.sh
set -uo pipefail
NODE="${KIT_NODE_URL:-http://127.0.0.1:3381}"
OUT="docs/evidence/live"
mkdir -p "$OUT"
cli() { node dist/cli.js "$@" --node "$NODE"; }
stamp() { echo "# $* ($(date -u +%FT%TZ), node $NODE)"; }

{ stamp "kit-client status"; cli status; } >"$OUT/status.txt" 2>&1

# Step 3: following feed for a public FID, timing, and the app filter.
{ stamp "kit-client feed --fid 37 --limit 20"; cli feed --fid 37 --limit 20; } >"$OUT/feed-37.txt" 2>&1
top_app=$(grep -oE "app fid [0-9]+" "$OUT/feed-37.txt" | head -1 | grep -oE "[0-9]+$")
if [ -n "$top_app" ]; then
  { stamp "kit-client feed --fid 37 --limit 20 --exclude $top_app"; cli feed --fid 37 --limit 20 --exclude "$top_app"; } >"$OUT/feed-37-exclude.txt" 2>&1
  { stamp "kit-client feed --fid 37 --limit 20 --include $top_app"; cli feed --fid 37 --limit 20 --include "$top_app"; } >"$OUT/feed-37-include.txt" 2>&1
fi

# Upstream PR 1: /v1/casts does not exist, /v1/castsByFid does.
{
  stamp "pagination example"
  echo "\$ curl -s -o /dev/null -w '%{http_code}' '$NODE/v1/casts?fid=2&pageSize=3'"
  curl -s -o /dev/null -w '%{http_code}\n' "$NODE/v1/casts?fid=2&pageSize=3"
  echo "\$ curl -s '$NODE/v1/castsByFid?fid=2&pageSize=3' | jq '.messages | length'"
  curl -s "$NODE/v1/castsByFid?fid=2&pageSize=3" | jq '.messages | length'
} >"$OUT/upstream-1-casts-route.txt" 2>&1

# Upstream PR 2 / 5: signer endpoints and requesterFids parsing on mainnet.
{
  stamp "signer endpoints, FID 3"
  key=$(curl -gs "$NODE/v1/signersByFid?fid=3&pageSize=1" | jq -r '.signers[0].key')
  echo "\$ curl -g '$NODE/v1/signer?fid=3&signer=$key'"
  curl -gs "$NODE/v1/signer?fid=3&signer=$key" | jq 'del(.signer.onChainEvent.signerEventBody.metadata)'
  for q in "fid=3&requesterFids=9152" "fid=3&requesterFids%5B0%5D=9152" "fid=3&requesterFids[0]=9152"; do
    echo "\$ curl -g '$NODE/v1/signersByFid?$q&pageSize=1' | jq '{currentUserNonce, requesterFidNonces}'"
    r=$(curl -gs "$NODE/v1/signersByFid?$q&pageSize=1")
    jq -c '{currentUserNonce, requesterFidNonces}' <<<"$r" 2>/dev/null || echo "$r"
  done
} >"$OUT/upstream-2-signers.txt" 2>&1

echo "wrote $(find "$OUT" -type f | wc -l) files to $OUT"
