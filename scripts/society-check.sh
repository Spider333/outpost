#!/usr/bin/env bash
# Checks a society node from the outside, the way any member can: the gate refuses requests
# without your token, lets through only reads and posts, serves no page, and limits how fast one
# member can read. The token is read from a file and never put on a command line.
# Needs curl 7.84 or newer.
#
# Usage: scripts/society-check.sh <node URL> <token file>

set -euo pipefail

NODE="${1:?usage: society-check.sh <node URL> <token file>}"
TOKEN_FILE="${2:?usage: society-check.sh <node URL> <token file>}"

umask 077
HDR="$(mktemp)"
trap 'rm -f "$HDR"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d ' \n' <"$TOKEN_FILE")" >"$HDR"

code() { curl -s -o /dev/null -m 60 -w '%{http_code}' "$@"; }

echo "without a token:          $(code "$NODE/v1/info")"
echo "with a wrong token:       $(code -H 'Authorization: Bearer 0000' "$NODE/v1/info")"
echo "with your token:          $(code -H @"$HDR" "$NODE/v1/info")"
echo "a page (/):               $(code -H @"$HDR" "$NODE/")"
echo "POST /v1/validateMessage: $(code -X POST -H @"$HDR" "$NODE/v1/validateMessage")"
echo "DELETE /v1/info:          $(code -X DELETE -H @"$HDR" "$NODE/v1/info")"
echo "type of a reply:          $(curl -s -o /dev/null -m 60 -w '%{content_type}' -H @"$HDR" "$NODE/v1/info")"
echo "300 reads at once (count, status, Retry-After):"
args=()
for i in $(seq 300); do args+=(-o /dev/null "$NODE/v1/userDataByFid?fid=3&n=$i"); done
curl -s --http2 --parallel --parallel-max 200 -H @"$HDR" -w '%{http_code} %header{retry-after}\n' "${args[@]}" | sort | uniq -c
