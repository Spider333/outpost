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
#   society.sh sponsor-on    the sponsor's bundle (dist/sponsor.js) on stdin; needs society mode
#                            and OUTPOST_SOCIETY_HOST; prints the wallet to fund
#   society.sh sponsor-off   stops it; keeps the wallet key and the counts
#   society.sh sponsor-status
#   society.sh app-signin-account   the app account's JSON on stdin (fid, custodyKey, address);
#                            stored mode 600 in $DIR/appsignin
#   society.sh app-signin-on the sign-in bundle (dist/appsignin.js) on stdin; needs society mode,
#                            the app account and OUTPOST_SOCIETY_HOST
#   society.sh app-signin-off   stops it and deletes the app account's key from this server
#   society.sh app-signin-status
#
# Caddy (official image, pinned) gets a TLS certificate for <ip>.sslip.io and passes every request
# to the gate, which checks the token and lets only GET /v1/* and POST /v1/submitMessage through
# to the node on 127.0.0.1:3381. The server serves no web page and no JavaScript in this mode:
# members load the client from GitHub Pages or run it themselves. The gate runs from its source
# file in the official Node image, so the file in $DIR/gate is the code that runs.
# The members file holds "<name> <SHA-256 hex>" lines, never a token.
#
# The sponsor (optional, src/server/sponsor.ts) pays for members' new Farcaster accounts from a
# hot wallet whose key is made here and stays in $DIR/sponsor/key. Caddy sends /sponsor/* to it
# and everything else to the gate. Keep only a little ETH in that wallet.
#
# "Approve in the Farcaster app" (optional, src/server/appsignin.ts) signs members' key requests
# with an app account whose custody key the host sent here ($DIR/appsignin/account.json, mode
# 600). Caddy sends /app-signin and /app-signin/* to it, members only.

set -euo pipefail

CADDY_IMAGE="caddy:2.10.2"
NODE_IMAGE="node:24.21.0-alpine"
GATE_PORT=3390
SPONSOR_PORT=3391
APPSIGNIN_PORT=3392
DIR="${OUTPOST_SOCIETY_DIR:-/srv/outpost-society}"
MEMBERS="$DIR/gate/members"
SPONSOR="$DIR/sponsor"
APPSIGNIN="$DIR/appsignin"

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

# No access log (no `log` in the site), and the loggers that write a request's URI, query,
# headers or client IP are dropped: http.log (incl. the error log when the gate is down),
# http.handlers (reverse_proxy), http.stdlib (TLS handshake errors) and tls.handshake
# (client addresses, at debug level). Start-up and certificate messages stay.
# /sponsor/* goes to the sponsor only while it is on ($SPONSOR/on exists), /app-signin* to the
# sign-in service only while it is on ($APPSIGNIN/on).
write_caddyfile() {
  : "${OUTPOST_SOCIETY_HOST:?missing OUTPOST_SOCIETY_HOST}"
  local route="	reverse_proxy 127.0.0.1:${GATE_PORT}" extra=""
  if [ -f "$SPONSOR/on" ]; then
    extra="	handle /sponsor/* {
		reverse_proxy 127.0.0.1:${SPONSOR_PORT}
	}
"
  fi
  if [ -f "$APPSIGNIN/on" ]; then
    extra="${extra}	handle /app-signin* {
		reverse_proxy 127.0.0.1:${APPSIGNIN_PORT}
	}
"
  fi
  if [ -n "$extra" ]; then
    route="${extra}	handle {
		reverse_proxy 127.0.0.1:${GATE_PORT}
	}"
  fi
  cat >"$DIR/caddy/Caddyfile" <<EOF
{
	log {
		exclude http.log http.handlers http.stdlib tls.handshake
	}
}
${OUTPOST_SOCIETY_HOST} {
${route}
	header -Server
}
EOF
  if ! out="$(docker run --rm -v "$DIR/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
    echo "$out" >&2
    die "generated Caddyfile is invalid"
  fi
}

reload_caddy() {
  exists outpost-society || die "society mode is off. Turn it on first: ./outpost society on"
  docker exec outpost-society caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
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
    write_caddyfile
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
    docker rm -f outpost-society outpost-gate outpost-sponsor outpost-appsignin >/dev/null 2>&1 || true
    rm -f "$SPONSOR/on" "$APPSIGNIN/on"
    say "stopped. Members, the sponsor's wallet key, the app account and the certificate are kept in $DIR"
    ;;
  sponsor-on)
    exists outpost-society || die "society mode is off. Turn it on first: ./outpost society on"
    mkdir -p "$SPONSOR/state"
    cat >"$SPONSOR/sponsor.js.tmp"
    [ -s "$SPONSOR/sponsor.js.tmp" ] || die "no sponsor bundle on stdin"
    mv "$SPONSOR/sponsor.js.tmp" "$SPONSOR/sponsor.js"
    if [ ! -s "$SPONSOR/key" ]; then
      # The wallet's key is made on this server and never leaves it.
      (umask 077; docker run --rm "$NODE_IMAGE" node -e 'console.log("0x" + require("crypto").randomBytes(32).toString("hex"))' >"$SPONSOR/key.tmp")
      grep -Eq '^0x[0-9a-f]{64}$' "$SPONSOR/key.tmp" || die "could not make a wallet key"
      mv "$SPONSOR/key.tmp" "$SPONSOR/key"
    fi
    chmod 600 "$SPONSOR/key"
    # If the new sponsor does not start, nothing answers /sponsor/* any more (an old one was just
    # removed), so Caddy goes back to sending everything to the gate.
    sponsor_failed() {
      docker logs outpost-sponsor 2>&1 | tail -5 >&2 || true
      docker rm -f outpost-sponsor >/dev/null 2>&1 || true
      rm -f "$SPONSOR/on"
      write_caddyfile
      reload_caddy
      die "$1"
    }
    : >"$SPONSOR/on"
    docker rm -f outpost-sponsor >/dev/null 2>&1 || true
    # Host networking: it reaches the Optimism RPC and listens on 127.0.0.1 only. It reads the
    # gate's members file and writes only its counts file. The gate's folder is mounted, not the
    # members file: `add` and `remove` move a new file into place, which a file mount would miss.
    docker run -d --name outpost-sponsor --restart unless-stopped --network host \
      --read-only --cap-drop ALL --security-opt no-new-privileges \
      -e OUTPOST_SPONSOR_PORT="$SPONSOR_PORT" -e OUTPOST_SPONSOR_PER_MEMBER -e OUTPOST_SPONSOR_PER_DAY -e OUTPOST_SPONSOR_RPC -e OUTPOST_SPONSOR_DRY_RUN \
      -e OUTPOST_SPONSOR_MEMBERS=/gate/members \
      -v "$SPONSOR/sponsor.js:/sponsor/sponsor.js:ro" -v "$SPONSOR/key:/sponsor/key:ro" \
      -v "$DIR/gate:/gate:ro" -v "$SPONSOR/state:/state" \
      "$NODE_IMAGE" node /sponsor/sponsor.js >/dev/null || sponsor_failed "could not start the sponsor container"
    wallet=""
    for _ in $(seq 1 20); do
      wallet="$(docker logs outpost-sponsor 2>&1 | grep -Eo 'wallet 0x[0-9a-fA-F]{40}' | head -1 | cut -d' ' -f2)" && [ -n "$wallet" ] && break
      sleep 1
    done
    [ -n "$wallet" ] || sponsor_failed "the sponsor did not start"
    write_caddyfile
    reload_caddy
    say "sponsor on: members can create an account; you pay its fee (one storage unit) from $wallet"
    say "send a little ETH on Optimism to $wallet (about \$0.21 per account)"
    ;;
  sponsor-off)
    docker rm -f outpost-sponsor >/dev/null 2>&1 || true
    rm -f "$SPONSOR/on"
    if exists outpost-society; then write_caddyfile; reload_caddy; fi
    say "sponsor off. Its wallet key stays in $SPONSOR/key; the ETH in it is still yours"
    ;;
  sponsor-status)
    if exists outpost-sponsor; then
      say "outpost-sponsor: $(docker inspect -f '{{.State.Status}}' outpost-sponsor)"
      docker logs outpost-sponsor 2>&1 | grep -E 'sponsor: (wallet|paid)' | tail -2
    else
      say "outpost-sponsor: not running"
    fi
    ;;
  app-signin-account)
    mkdir -p "$APPSIGNIN"
    chmod 700 "$APPSIGNIN"
    (umask 077; cat >"$APPSIGNIN/account.json.tmp")
    if ! grep -Eq '"custodyKey": *"0x[0-9a-fA-F]{64}"' "$APPSIGNIN/account.json.tmp" || ! grep -Eq '"fid": *[0-9]+' "$APPSIGNIN/account.json.tmp"; then
      rm -f "$APPSIGNIN/account.json.tmp"
      die "expected the app account's JSON on stdin"
    fi
    mv "$APPSIGNIN/account.json.tmp" "$APPSIGNIN/account.json"
    chmod 600 "$APPSIGNIN/account.json"
    say "app account stored in $APPSIGNIN/account.json (mode 600)"
    ;;
  app-signin-on)
    exists outpost-society || die "society mode is off. Turn it on first: ./outpost society on"
    [ -s "$APPSIGNIN/account.json" ] || die "no app account on this server. Run ./outpost app-account --society"
    cat >"$APPSIGNIN/appsignin.js.tmp"
    [ -s "$APPSIGNIN/appsignin.js.tmp" ] || die "no sign-in bundle on stdin"
    mv "$APPSIGNIN/appsignin.js.tmp" "$APPSIGNIN/appsignin.js"
    appsignin_failed() {
      docker logs outpost-appsignin 2>&1 | tail -5 >&2 || true
      docker rm -f outpost-appsignin >/dev/null 2>&1 || true
      rm -f "$APPSIGNIN/on"
      write_caddyfile
      reload_caddy
      die "$1"
    }
    : >"$APPSIGNIN/on"
    docker rm -f outpost-appsignin >/dev/null 2>&1 || true
    # Host networking: it reaches Farcaster's endpoint and listens on 127.0.0.1 only. It reads
    # the app account and the gate's members file, and writes nothing.
    docker run -d --name outpost-appsignin --restart unless-stopped --network host \
      --read-only --cap-drop ALL --security-opt no-new-privileges \
      -e OUTPOST_APPSIGNIN_PORT="$APPSIGNIN_PORT" -e OUTPOST_APPSIGNIN_MEMBERS=/gate/members \
      -e OUTPOST_APPSIGNIN_ACCOUNT=/appsignin/account.json \
      -v "$APPSIGNIN/appsignin.js:/appsignin/appsignin.js:ro" -v "$APPSIGNIN/account.json:/appsignin/account.json:ro" \
      -v "$DIR/gate:/gate:ro" \
      "$NODE_IMAGE" node /appsignin/appsignin.js >/dev/null || appsignin_failed "could not start the sign-in container"
    fid=""
    for _ in $(seq 1 20); do
      fid="$(docker logs outpost-appsignin 2>&1 | grep -Eo 'app account FID [0-9]+' | head -1 | awk '{ print $4 }')" && [ -n "$fid" ] && break
      sleep 1
    done
    [ -n "$fid" ] || appsignin_failed "the sign-in service did not start"
    write_caddyfile
    reload_caddy
    say "approve in the Farcaster app: on for members, requests come from FID $fid"
    ;;
  app-signin-off)
    docker rm -f outpost-appsignin >/dev/null 2>&1 || true
    rm -f "$APPSIGNIN/on" "$APPSIGNIN/account.json" "$APPSIGNIN/account.json.tmp"
    if exists outpost-society; then write_caddyfile; reload_caddy; fi
    say "approve in the Farcaster app: off. The app account's key was deleted from this server"
    ;;
  app-signin-status)
    if exists outpost-appsignin; then
      say "outpost-appsignin: $(docker inspect -f '{{.State.Status}}' outpost-appsignin)"
      docker logs outpost-appsignin 2>&1 | grep -E 'app-signin: ' | tail -1
    else
      say "outpost-appsignin: not running"
    fi
    ;;
  status)
    for c in outpost-society outpost-gate outpost-sponsor outpost-appsignin; do
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
