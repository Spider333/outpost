#!/usr/bin/env bash
# Serves the web client from the node server over HTTPS with a password, so you can use it
# from a phone. Run as root by `./outpost client --phone`. Safe to run again.
#
# Caddy (official image, pinned) gets a TLS certificate for <ip>.sslip.io, a public DNS name
# that points at the server's IP, so no domain is needed. Every request, including /v1/*
# to the node, needs the password: an open node API would let anyone submit messages.
#
# Input (environment): OUTPOST_PHONE_HOST, OUTPOST_PHONE_HASH (bcrypt). The built client must already
# be in /srv/outpost-web. OUTPOST_PHONE_OFF=1 stops and removes it.

set -euo pipefail

CADDY_IMAGE="caddy:2.10.2"
DIR="${OUTPOST_PHONE_DIR:-/srv/outpost-phone}"
WEB="${OUTPOST_PHONE_WEB:-/srv/outpost-web}"
UPSTREAM="${OUTPOST_PHONE_UPSTREAM:-127.0.0.1:3381}"

if [ "${OUTPOST_PHONE_OFF:-0}" = "1" ]; then
  docker rm -f outpost-phone >/dev/null 2>&1 || true
  echo "[phone] stopped"
  exit 0
fi

if docker inspect outpost-society >/dev/null 2>&1; then
  echo "[phone] society mode is on and also uses port 443. Turn it off first: ./outpost society off" >&2
  exit 1
fi
: "${OUTPOST_PHONE_HOST:?missing OUTPOST_PHONE_HOST}"
: "${OUTPOST_PHONE_HASH:?missing OUTPOST_PHONE_HASH}"
[ -f "$WEB/index.html" ] || { echo "[phone] $WEB is empty" >&2; exit 1; }

mkdir -p "$DIR/data" "$DIR/config"
cat >"$DIR/Caddyfile" <<EOF
${OUTPOST_PHONE_HOST} {
	basic_auth {
		outpost ${OUTPOST_PHONE_HASH}
	}
	header {
		Content-Security-Policy "default-src 'self'; img-src * data:; style-src 'self'; script-src 'self'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		X-Frame-Options DENY
		-Server
	}
	handle /v1/* {
		reverse_proxy ${UPSTREAM}
	}
	handle {
		root * /srv/outpost-web
		file_server
	}
}
EOF

if ! out="$(docker run --rm -v "$DIR/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
  echo "$out" >&2
  echo "[phone] generated Caddyfile is invalid" >&2
  exit 1
fi
[ "${OUTPOST_PHONE_RENDER_ONLY:-0}" = "1" ] && { echo "[phone] wrote and validated $DIR/Caddyfile"; exit 0; }

if docker inspect outpost-phone >/dev/null 2>&1; then
  docker exec outpost-phone caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
else
  # Host networking so Caddy can reach the node API on 127.0.0.1:3381.
  docker run -d --name outpost-phone --restart unless-stopped --network host \
    -v "$DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "$DIR/data:/data" -v "$DIR/config:/config" \
    -v "$WEB:/srv/outpost-web:ro" \
    "$CADDY_IMAGE" >/dev/null
fi
echo "[phone] serving https://${OUTPOST_PHONE_HOST}"
