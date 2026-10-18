#!/usr/bin/env bash
# Serves the web client from the node server over HTTPS with a password, so you can use it
# from a phone. Run as root by `./kit client --phone`. Safe to run again.
#
# Caddy (official image, pinned) gets a TLS certificate for <ip>.sslip.io, a public DNS name
# that points at the server's IP, so no domain is needed. Every request, including /v1/*
# to the node, needs the password: an open node API would let anyone submit messages.
#
# Input (environment): KIT_PHONE_HOST, KIT_PHONE_HASH (bcrypt). The built client must already
# be in /srv/kit-web. KIT_PHONE_OFF=1 stops and removes it.

set -euo pipefail

CADDY_IMAGE="caddy:2.10.2"
DIR="${KIT_PHONE_DIR:-/srv/kit-phone}"
WEB="${KIT_PHONE_WEB:-/srv/kit-web}"
UPSTREAM="${KIT_PHONE_UPSTREAM:-127.0.0.1:3381}"

if [ "${KIT_PHONE_OFF:-0}" = "1" ]; then
  docker rm -f kit-phone >/dev/null 2>&1 || true
  echo "[phone] stopped"
  exit 0
fi

: "${KIT_PHONE_HOST:?missing KIT_PHONE_HOST}"
: "${KIT_PHONE_HASH:?missing KIT_PHONE_HASH}"
[ -f "$WEB/index.html" ] || { echo "[phone] $WEB is empty" >&2; exit 1; }

mkdir -p "$DIR/data" "$DIR/config"
cat >"$DIR/Caddyfile" <<EOF
${KIT_PHONE_HOST} {
	basic_auth {
		kit ${KIT_PHONE_HASH}
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
		root * /srv/kit-web
		file_server
	}
}
EOF

if ! out="$(docker run --rm -v "$DIR/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
  echo "$out" >&2
  echo "[phone] generated Caddyfile is invalid" >&2
  exit 1
fi
[ "${KIT_PHONE_RENDER_ONLY:-0}" = "1" ] && { echo "[phone] wrote and validated $DIR/Caddyfile"; exit 0; }

if docker inspect kit-phone >/dev/null 2>&1; then
  docker exec kit-phone caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
else
  # Host networking so Caddy can reach the node API on 127.0.0.1:3381.
  docker run -d --name kit-phone --restart unless-stopped --network host \
    -v "$DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "$DIR/data:/data" -v "$DIR/config:/config" \
    -v "$WEB:/srv/kit-web:ro" \
    "$CADDY_IMAGE" >/dev/null
fi
echo "[phone] serving https://${KIT_PHONE_HOST}"
