# Outpost

Three commands from nothing to your own Snapchain read node and a client for Farcaster
that reads from it and posts through it. No API keys from anyone.

```
./outpost provision   # rent a server with a 1.2 TB disk (DigitalOcean; 1 TB on Hetzner), billed by the hour
./outpost node        # start a Snapchain read node on it; first sync took about 6 hours on our test server
./outpost client      # open http://127.0.0.1:8381
```

When you are done:

```
./outpost uninstall   # revoke the app key; no recovery phrase needed
./outpost destroy     # delete the server and stop paying
```

Just trying it? `./outpost provision --watchdog 24` deletes the server for you after 24 hours,
or after 2 hours with no progress. Ran it? [VOUCHER.md](VOUCHER.md) has a checklist and a
draft cast.

The tutorial is at https://spider333.github.io/outpost/ (source: [site/index.html](site/index.html)).

## Before you paste a recovery phrase

A recovery phrase is the custody key of an account. Whoever has it can transfer the account,
add or remove every app key and change the username. Treat pasting it like running
`rm -rf /` as root. Use a test account only, prefer the wallet path, and revoke the key when
you are done. Outpost uses the phrase in memory to sign one authorization for a scoped,
expiring app key and keeps no copy.

## What you need

- A DigitalOcean (`doctl`) or Hetzner (`hcloud`) account, logged in. Or any Ubuntu 24.04
  server with root SSH and at least 1 TB of disk: `OUTPOST_HOST=<ip> ./outpost node`.
- Node.js 20 or newer, for the client.
- A test account for Farcaster that already has storage.

## What it does

- **provision**: creates a server, a 1.2 TB volume (`--disk` to change) and a firewall that opens only SSH (22/tcp)
  and gossip (3382/udp). `--dry-run` prints the exact provider commands. On Hetzner the volume is
  1 TB, because new Hetzner accounts can hold at most 1024 GB of volumes; the data fits, since
  Outpost never keeps the snapshot and the database on the volume at once.
- **watchdog**: `provision --watchdog <hours>`, or `./outpost watchdog start --hours <n>` later,
  deletes the server, volume and firewall when the time is up, or when the node shows the same
  progress for 2 hours (`--stall-hours`) once it has started. It runs on your computer, because
  deleting needs your provider login, which never goes to the server. If the computer sleeps,
  it acts when it wakes. `./outpost watchdog stop` keeps the server; `./outpost status` shows it.
- **node**: runs the official `farcasterxyz/snapchain` image, pinned to 0.14.3, as a read
  node. The HTTP and gRPC ports are bound to 127.0.0.1, because an open node lets anyone
  submit messages through it. It does not use the official installer, which needs a terminal
  and can stop before starting the node (snapchain issue #1030).
  On a new server it loads the network snapshot itself, 8 chunks at a time, streamed
  straight into the database: about 4 times faster than Snapchain's own loader, which goes
  one chunk at a time, and it never needs room for the snapshot and the database at once.
  Each shard goes into the database only when it is complete, and `./outpost node` resumes
  an interrupted load. `OUTPOST_FAST_RESTORE=0` uses Snapchain's loader instead.
- **client**: opens an SSH tunnel to the node and serves the web client on 127.0.0.1:8381.
  The client:
  - connects an account with a wallet signature, or a test account's recovery phrase;
  - adds a gasless app key (`KEY_ADD`) that can only cast, react and follow, and expires
    30 days after last use;
  - shows your following feed, built from your node, and labels each cast with the app
    that posted it; you can show only or hide any app;
  - casts, replies, likes, recasts, follows;
  - revokes its own key without the recovery phrase.
- **Societies (Charter)**: a society is a signed `charter.json`: members, moderators, which
  apps to include or exclude, feed rules and a code of conduct link. Loading one applies
  its lens; Join follows its members; Leave drops the lens and keeps your keys, follows and
  posts. A census panel shows members, active members, casts per day and the apps members
  post from, all computed from your node.

The command-line client has the same features: `./outpost cli --help`.

Settings, as environment variables:

- `OUTPOST_HOST=<ip>`: use a server you already have instead of the one `provision` made.
- `OUTPOST_SSH_KEY=<path>`: the SSH key for that server.
- `OUTPOST_TUNNEL_PORT` (default 13381): the local end of the SSH tunnel to the node.
  Change it if something on your machine already uses that port.
- `OUTPOST_PORT` (default 8381): where the web client is served.

To use the client from a phone, `./outpost client --phone` serves it from your server over HTTPS
(a certificate for `<ip>.sslip.io`, no domain needed) behind a password, and opens 443/tcp.
`./outpost client --phone off` closes it again.

## Shard 0 did not load

This can only happen to a node that loaded its snapshot with Snapchain's own loader, as
nodes set up before 19 October 2026 did. Outpost's loader moves each shard into place only
when it is complete.

Snapchain loads its snapshot one shard after another, shard 0 last, and only when its
database folder is empty. If the node is restarted during the load, it starts with whatever
it has, and shard 0 stays empty. Feeds still work, because casts live on shards 1 and 2,
but shard 0 is where app keys are checked, so logging in fails with `unknown fid`.
`./outpost status` and `./outpost node` say so when this happens.

To fix it, replace shard 0 with the official snapshot. On the server, in the folder that
holds `docker-compose.yml`, these are the steps we ran, minus our retry loop for slow
chunks (about 30 GB to download, 6 minutes to unpack):

```bash
B=https://pub-d352dd8819104a778e20d08888c5a661.r2.dev
mkdir -p ../s0 && curl -fsS "$B/FARCASTER_NETWORK_MAINNET/0/latest.json" -o ../s0/latest.json
kb=$(jq -r .key_base ../s0/latest.json)
jq -r '.chunks[]' ../s0/latest.json | xargs -P 8 -I{} curl -fsS -o ../s0/{} "$B/$kb/{}"
docker compose stop snapchain
mv .rocks/shard-0 ../s0/shard-0.old
for c in $(jq -r '.chunks[]' ../s0/latest.json); do gzip -dc "../s0/$c"; done | tar -x -C .rocks
mv .rocks.snapshot ../rocks-snapshot.old
docker compose start snapchain
```

Shard 0 then catches up from the snapshot's date. Delete `../s0` and `../rocks-snapshot.old`
once `./outpost status` says synced.

## Layout

```
outpost              the three commands, plus status, cli, uninstall, destroy, watchdog
VOUCHER.md           checklist and draft cast for people who vouch for a run
infra/               cloud-init and the node setup script
src/core/            protocol code: node HTTP client, accounts, app keys, writes,
                     feed, app attribution, charters, census (runs in Node and browsers)
src/cli/             command-line client
src/web/             web client
src/server/serve.ts  local server for the web client, forwards /v1 to the node
test/                unit tests (npm test)
site/                microsite and tutorial
docs/evidence/       saved outputs from real runs
```

## Development

```
npm ci
npm test             # unit tests, including known test vectors
npm run test:providers   # provision and destroy against fake doctl and hcloud
npm run test:watchdog    # the watchdog, with a one-second hour
npm run test:restore     # the snapshot loader
npx tsc -p .         # typecheck
npm run build        # dist/web, dist/serve.js, dist/cli.js
```

`@farcaster/core` includes test-data factories that depend on `@faker-js/faker`, which has a
published advisory. Outpost never calls those factories, and the browser and CLI builds replace
faker with a small stand-in (`src/web/faker-stub.ts`).

## Licence and credits

MIT. Snapchain is GPL-3.0; Outpost only runs its official Docker image and includes none of its
code. Uses `@farcaster/core` and `viem` (both MIT).

An AI coding assistant helped write this code and its documentation.
