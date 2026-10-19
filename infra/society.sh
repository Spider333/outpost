#!/usr/bin/env bash
# Society mode on the node server: members use the node API from their own browsers, each with
# their own token. Run as root by `./outpost society` and `./outpost members`. Safe to run again.
#
#   society.sh on            the gate's source (src/server/gate.ts) on stdin;
#                            needs OUTPOST_SOCIETY_HOST (<ip>.sslip.io)
#   society.sh off           stops it; keeps the members file and the certificate
#   society.sh status
#   society.sh add <name>    the SHA-256 (hex) of the member's token on stdin; prints added or exists
#   society.sh remove <name>
#   society.sh list
#
# Caddy (official image, pinned) gets a TLS certificate for <ip>.sslip.io and passes every request
# to the gate, which checks the token and lets only GET /v1/* and POST /v1/submitMessage through
# to the node on 127.0.0.1:3381. The server serves no web page and no JavaScript in this mode:
# members load the client from GitHub Pages or run it themselves. The gate runs from its source
# file in the official Node image, so the file in $DIR/gate is the code that runs.
# The members file holds "<name> <SHA-256 hex>" lines, never a token.

set -euo pipefail

CADDY_IMAGE="caddy:2.10.2"
NODE_IMAGE="node:24.21.0-alpine"
GATE_PORT=3390
DIR="${OUTPOST_SOCIETY_DIR:-/srv/outpost-society}"
MEMBERS="$DIR/gate/members"

say() { printf '[society] %s\n' "$*"; }
die() { printf '[society] error: %s\n' "$*" >&2; exit 1; }

exists() { docker inspect "$1" >/dev/null 2>&1; }

is_member() { awk -v n="$1" '$1 == n { f = 1 } END { exit !f }' "$MEMBERS"; }

valid_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$ ]] || die "a member name is letters, digits, '.', '_' or '-', up to 40"
}

# A new file moved over the old one, so the gate never reads half of it.
write_members() {
  (umask 077; cat >"$MEMBERS.tmp")
  mv "$MEMBERS.tmp" "$MEMBERS"
  if exists outpost-gate; then docker kill -s HUP outpost-gate >/dev/null 2>&1 || true; fi
}

mkdir -p "$DIR/gate" "$DIR/caddy/data" "$DIR/caddy/config"
chmod 700 "$DIR"
[ -f "$MEMBERS" ] || (umask 077; : >"$MEMBERS")

action="${1:-status}"
case "$action" in
  on)
    : "${OUTPOST_SOCIETY_HOST:?missing OUTPOST_SOCIETY_HOST}"
    ! exists outpost-phone || die "phone access is on and also uses port 443. Turn it off first: ./outpost client --phone off"
    cat >"$DIR/gate/gate.ts.tmp"
    [ -s "$DIR/gate/gate.ts.tmp" ] || die "no gate source on stdin"
    mv "$DIR/gate/gate.ts.tmp" "$DIR/gate/gate.ts"
    cat >"$DIR/caddy/Caddyfile" <<EOF
${OUTPOST_SOCIETY_HOST} {
	reverse_proxy 127.0.0.1:${GATE_PORT}
	header -Server
}
EOF
    if ! out="$(docker run --rm -v "$DIR/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
      echo "$out" >&2
      die "generated Caddyfile is invalid"
    fi
    # Started again every time, so it runs the source just copied. Host networking so it can
    # reach the node on 127.0.0.1:3381; it listens on 127.0.0.1 only. The rate limits pass
    # through when set (see src/server/gate.ts).
    docker rm -f outpost-gate >/dev/null 2>&1 || true
    docker run -d --name outpost-gate --restart unless-stopped --network host \
      --read-only --cap-drop ALL --security-opt no-new-privileges \
      -e OUTPOST_GATE_MEMBERS=/gate/members -e OUTPOST_GATE_PORT="$GATE_PORT" \
      -e OUTPOST_GATE_READ_RATE -e OUTPOST_GATE_READ_BURST -e OUTPOST_GATE_SUBMIT_RATE -e OUTPOST_GATE_SUBMIT_BURST \
      -v "$DIR/gate:/gate:ro" \
      "$NODE_IMAGE" node /gate/gate.ts >/dev/null
    if exists outpost-society; then
      docker exec outpost-society caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
    else
      docker run -d --name outpost-society --restart unless-stopped --network host \
        -v "$DIR/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
        -v "$DIR/caddy/data:/data" -v "$DIR/caddy/config:/config" \
        "$CADDY_IMAGE" >/dev/null
    fi
    say "serving the node API at https://${OUTPOST_SOCIETY_HOST} to members only (no web page)"
    ;;
  off)
    docker rm -f outpost-society outpost-gate >/dev/null 2>&1 || true
    say "stopped. Members and the certificate are kept in $DIR"
    ;;
  status)
    for c in outpost-society outpost-gate; do
      if exists "$c"; then say "$c: $(docker inspect -f '{{.State.Status}}' "$c")"; else say "$c: not running"; fi
    done
    say "members: $(grep -c . "$MEMBERS" || true)"
    ;;
  add)
    name="${2:-}"
    valid_name "$name"
    read -r hash || true
    [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || die "expected the token's SHA-256 (64 hex digits) on stdin"
    if is_member "$name"; then echo exists; exit 0; fi
    { cat "$MEMBERS"; echo "$name $hash"; } | write_members
    echo added
    ;;
  remove)
    name="${2:-}"
    valid_name "$name"
    is_member "$name" || { say "$name is not a member"; exit 0; }
    awk -v n="$name" '$1 != n' "$MEMBERS" | write_members
    say "removed $name; their link stopped working"
    ;;
  list)
    if [ -s "$MEMBERS" ]; then awk '{ print $1 }' "$MEMBERS"; else say "no members yet"; fi
    ;;
  *) die "unknown action: $action" ;;
esac
