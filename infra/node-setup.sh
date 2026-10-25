#!/usr/bin/env bash
# Sets up a Snapchain read node on an Ubuntu 24.04 server. Run as root. Safe to run again.
#
# Uses the official farcasterxyz/snapchain Docker image and compose file, pinned to one
# release, and avoids two problems in the official installer: it reads from /dev/tty (so it
# fails without a terminal), and with HUB_OPERATOR_FID=0 it exits before starting the node
# (snapchain issue #1030). This script does not use the installer at all.
#
# Changes to the official compose file, each checked after it is applied:
#   - image pinned to SNAPCHAIN_VERSION instead of :latest, no forced pull
#   - HTTP (3381) and gRPC (3383) bound to 127.0.0.1: by default anyone can send writes
#     through an open node, and the client reaches the node over an SSH tunnel anyway
#   - statsd bound to 127.0.0.1; Grafana is not started
#   - the node's log capped at 3 x 50 MB: it grew by about 0.9 GB a day on fcprize-node, which
#     would fill a small server's disk within months
# Gossip (3382/udp) stays public: the node needs it to sync and to relay your writes.
#
# On a new server the snapshot is loaded by snapshot-restore.sh (8 parallel downloads streamed
# into the database, about 600 GB on disk) instead of Snapchain's own loader, which goes one
# chunk at a time and needs about twice the disk. Set OUTPOST_FAST_RESTORE=0 to use Snapchain's.

set -euo pipefail

SNAPCHAIN_VERSION="${SNAPCHAIN_VERSION:-0.15.0}"
DATA_DIR="${OUTPOST_DATA_DIR:-}"
# 900, not 1000: a new 1000 GB volume shows less than 1000 GB free after formatting, and new
# Hetzner accounts cannot have a bigger one.
MIN_FREE_GB="${OUTPOST_MIN_FREE_GB:-900}"
RESTORE=/usr/local/lib/outpost/snapshot-restore.sh

log() { printf '[node-setup] %s\n' "$*"; }
die() { printf '[node-setup] error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"

free_gb() { df -BG --output=avail "$1" 2>/dev/null | tail -1 | tr -dc '0-9'; }

# Pick where the ~600 GB of chain data goes (it grows): an attached volume if there is one.
find_data_dir() {
  local mp
  # Hetzner (--automount) mounts volumes at /mnt/HC_Volume_<id>; DigitalOcean at /mnt/<name>.
  for mp in /mnt/snap /mnt/HC_Volume_* /mnt/*; do
    [ -d "$mp" ] || continue
    mountpoint -q "$mp" || continue
    if [ "$(free_gb "$mp")" -ge "$MIN_FREE_GB" ] || [ -d "$mp/snapchain/.rocks" ]; then
      echo "$mp"
      return 0
    fi
  done
  # An attached but unformatted DigitalOcean volume: format and mount it.
  local dev
  for dev in /dev/disk/by-id/scsi-0DO_Volume_*; do
    [ -e "$dev" ] || continue
    if ! blkid "$dev" >/dev/null 2>&1; then
      log "formatting $dev as ext4"
      mkfs.ext4 -q -F "$dev"
    fi
    mkdir -p /mnt/snap
    mountpoint -q /mnt/snap || mount -o defaults,noatime,discard "$dev" /mnt/snap
    grep -q " /mnt/snap " /etc/fstab || echo "$dev /mnt/snap ext4 defaults,nofail,noatime,discard 0 2" >>/etc/fstab
    echo /mnt/snap
    return 0
  done
  if [ "$(free_gb /)" -ge "$MIN_FREE_GB" ]; then
    echo /srv
    return 0
  fi
  return 1
}

if [ -z "$DATA_DIR" ]; then
  DATA_DIR="$(find_data_dir)" || die "no disk with ${MIN_FREE_GB} GB free. The chain data is about 600 GB and growing. Attach a volume of 1 TB or more."
fi
log "data directory: $DATA_DIR ($(free_gb "$DATA_DIR") GB free)"

export DEBIAN_FRONTEND=noninteractive
# On a fresh server unattended-upgrades often holds the dpkg lock for a few minutes.
APT=(apt-get -q -o DPkg::Lock::Timeout=600)
pkgs=()
command -v docker >/dev/null 2>&1 || pkgs+=(docker.io)
docker compose version >/dev/null 2>&1 || pkgs+=(docker-compose-v2)
command -v jq >/dev/null 2>&1 || pkgs+=(jq)
command -v curl >/dev/null 2>&1 || pkgs+=(curl)
command -v pigz >/dev/null 2>&1 || pkgs+=(pigz)
if [ "${#pkgs[@]}" -gt 0 ]; then
  log "installing ${pkgs[*]}"
  "${APT[@]}" update
  "${APT[@]}" install -y "${pkgs[@]}"
  systemctl enable --now docker
fi

DIR="$DATA_DIR/snapchain"
mkdir -p "$DIR"
cd "$DIR"

BASE="https://raw.githubusercontent.com/farcasterxyz/snapchain/v${SNAPCHAIN_VERSION}"
# Rewrite the compose file unless it is already ours: right version and API ports on
# 127.0.0.1. An install made some other way may publish 3381/3383 to the world.
LOG_CAP='    logging: { driver: json-file, options: { max-size: "50m", max-file: "3" } }'
compose_ok() {
  [ -f docker-compose.yml ] &&
    grep -qF "farcasterxyz/snapchain:${SNAPCHAIN_VERSION}" docker-compose.yml &&
    grep -qF '"127.0.0.1:3381:3381/tcp"' docker-compose.yml &&
    grep -qF '"127.0.0.1:3383:3383/tcp"' docker-compose.yml &&
    grep -qxF "$LOG_CAP" docker-compose.yml
}
if ! compose_ok; then
  log "fetching compose file for snapchain v${SNAPCHAIN_VERSION}"
  curl -fsSLo docker-compose.yml.new "$BASE/docker-compose.mainnet.yml"
  curl -fsSLo validators.toml "$BASE/validators.toml"
  sed -i \
    -e "s#farcasterxyz/snapchain:latest#farcasterxyz/snapchain:${SNAPCHAIN_VERSION}#" \
    -e "s#pull_policy: always#pull_policy: missing#" \
    -e 's#"3381:3381/tcp"#"127.0.0.1:3381:3381/tcp"#' \
    -e 's#"3383:3383/tcp"#"127.0.0.1:3383:3383/tcp"#' \
    -e "s#'\${STATSD_PUBLISH:-8125}:8125/udp'#'127.0.0.1:8125:8125/udp'#" \
    -e "s#'\${STATSD_ADMIN_PUBLISH:-8126}:8126'#'127.0.0.1:8126:8126'#" \
    docker-compose.yml.new
  # Only the snapchain service has "restart: always".
  sed -i "s#^    restart: always\$#&\n$LOG_CAP#" docker-compose.yml.new
  for want in "farcasterxyz/snapchain:${SNAPCHAIN_VERSION}" '"127.0.0.1:3381:3381/tcp"' '"127.0.0.1:3383:3383/tcp"' "'127.0.0.1:8125:8125/udp'" "$LOG_CAP"; do
    grep -qF "$want" docker-compose.yml.new || die "compose file layout changed upstream; could not apply: $want"
  done
  [ "$(grep -cxF "$LOG_CAP" docker-compose.yml.new)" -eq 1 ] || die "compose file layout changed upstream; the log cap went to more than one service"
  mv docker-compose.yml.new docker-compose.yml
fi
# A restore by snapshot-restore.sh runs as the outpost-restore unit and starts the node itself
# when it is done (it runs this script again with OUTPOST_FROM_RESTORE=1).
if [ -z "${OUTPOST_FROM_RESTORE:-}" ] && systemctl is-active --quiet outpost-restore 2>/dev/null; then
  log "the snapshot is still loading in the background; leaving the node alone. Check ./outpost status."
  exit 0
fi
mkdir -p .rocks .rocks.snapshot .onchain-config
# New server (empty .rocks, node never started), or an unfinished restore (.restore exists):
# load the snapshot with snapshot-restore.sh.
if [ -z "${OUTPOST_FROM_RESTORE:-}" ] && [ "${OUTPOST_FAST_RESTORE:-1}" = 1 ] && [ -f "$RESTORE" ] &&
  { [ -d .restore ] || { [ -z "$(ls -A .rocks)" ] && [ -z "$(docker compose ps -aq snapchain 2>/dev/null)" ]; }; }; then
  systemctl reset-failed outpost-restore >/dev/null 2>&1 || true
  systemd-run --unit=outpost-restore --collect --quiet /bin/bash "$RESTORE" "$DIR"
  log "loading the snapshot in the background: 8 downloads at a time, streamed into the database."
  log "the node starts by itself when all three shards are in. Check progress with ./outpost status."
  exit 0
fi
# Snapchain loads the snapshot one shard after another, shard 0 last, and deletes
# .rocks.snapshot when it is done (Docker recreates the empty mount folder). On a restart it
# skips the snapshot as soon as .rocks has any data, so restarting it mid-load leaves the
# remaining shards empty for good. A leftover metadata.json means a load has not finished.
if [ -f .rocks.snapshot/metadata.json ] && [ -n "$(ls -A .rocks 2>/dev/null)" ]; then
  if [ -n "$(docker compose ps -q snapchain 2>/dev/null)" ] && ! curl -fsm 5 http://127.0.0.1:3381/v1/info >/dev/null 2>&1; then
    compose_ok || log "warning: until it finishes, this node's API ports are open as its old compose file says."
    log "the node is still loading its snapshot; not restarting it. Run this again when ./outpost status shows synced or catching up."
    exit 0
  fi
  die "an earlier snapshot load on this server was interrupted, so some shards are missing. See \"Shard 0 did not load\" in the README."
fi
log "starting snapchain ${SNAPCHAIN_VERSION} (read node)"
docker compose up -d snapchain statsd
docker compose ps --format '{{.Name}} {{.Status}}'
for p in 3381 3383; do
  bound="$(docker compose port snapchain "$p" 2>/dev/null || true)"
  case "$bound" in
    127.0.0.1:*) ;;
    *) die "port $p is published on '${bound:-nothing}', not 127.0.0.1 only. Stop the node and check docker-compose.yml." ;;
  esac
done
log "done. HTTP API on 127.0.0.1:3381 once the snapshot has loaded."
