# Outpost

[![test](https://github.com/Spider333/outpost/actions/workflows/test.yml/badge.svg)](https://github.com/Spider333/outpost/actions/workflows/test.yml)

Outpost gives you your own way into Farcaster: a server running a Snapchain read node, and a
client on your computer that reads from that node and posts through it. Three commands, no API
keys from anyone.

It is for people who want to read and post on Farcaster from infrastructure they control, and
for developers who want a tested example of reading straight from Snapchain and adding a gasless
app key.

- **What you get**: a Snapchain read node on a server you rent, a web client at
  http://127.0.0.1:8381, and a command-line client with the same features.
- **What it costs**: the server, billed by the hour while it exists. The DigitalOcean default is
  about $0.41/h: an 8 vCPU / 32 GB droplet at $0.25/h plus a 1.2 TB volume at about $0.16/h
  (October 2026 list prices). `./outpost destroy` deletes the server, volume and firewall and
  stops the bill.
- **How long it takes**: the first sync took about 6 hours on our test server (DigitalOcean,
  8 vCPU, 32 GB RAM, 1.2 TB volume, 18 to 19 October 2026): 1 h 43 min to load the snapshot,
  4 h 11 min to catch up. The client works once loading is done.

Tutorial, with the output of every step from a real run: https://spider333.github.io/outpost/
(source: [site/index.html](site/index.html)).

## Quickstart

You need:

- A DigitalOcean (`doctl`) or Hetzner (`hcloud`) account, logged in. Or any Ubuntu 24.04
  server with root SSH and 1.2 TB of disk: `OUTPOST_HOST=<ip> ./outpost node`.
- Node.js 20 or newer, for the client.
- A test account for Farcaster that already has storage.

```
./outpost provision   # rent a server with a 1.2 TB disk (DigitalOcean or Hetzner), billed by the hour
./outpost node        # start a Snapchain read node on it; first sync took about 6 hours on our test server
./outpost client      # open http://127.0.0.1:8381
```

When you are done:

```
./outpost uninstall   # revoke the app key; no recovery phrase needed
./outpost destroy     # delete the server and stop paying
```

Every command is safe to run twice. `./outpost provision --dry-run` and
`./outpost destroy --dry-run` print the exact provider commands without running them.
`./outpost status` shows the server and how far the node has synced.

## Before you paste a recovery phrase

A recovery phrase is the custody key of an account. Whoever has it can transfer the account,
add or remove every app key and change the username. Treat pasting it like running
`rm -rf /` as root. Use a test account only, prefer the wallet path, and revoke the key when
you are done. Outpost uses the phrase in memory to sign one authorization for a scoped,
expiring app key and keeps no copy.

## How it works

```mermaid
flowchart LR
  subgraph you["Your computer"]
    B["Browser"] -->|"127.0.0.1:8381"| S["Outpost client server"]
    C["./outpost cli"]
  end
  subgraph srv["Your rented server"]
    N["Snapchain read node<br/>API on 127.0.0.1:3381"]
  end
  S -->|"SSH tunnel"| N
  C -->|"SSH tunnel"| N
  N <-->|"gossip, 3382/udp"| F["Farcaster network"]
```

- **provision** creates a server, a 1.2 TB volume (`--disk` to change) and a firewall that opens
  only SSH (22/tcp) and gossip (3382/udp).
- **node** runs the official `farcasterxyz/snapchain` image, pinned to 0.14.3, as a read node.
  The HTTP and gRPC ports are bound to 127.0.0.1, because an open node lets anyone submit
  messages through it. It does not use the official installer, which needs a terminal and can
  stop before starting the node (snapchain issue #1030).
  On a new server it loads the network snapshot itself, 8 chunks at a time, streamed straight
  into the database: about 4 times faster than Snapchain's own loader, which goes one chunk at a
  time, and it never needs room for the snapshot and the database at once. Each shard goes into
  the database only when it is complete, and `./outpost node` resumes an interrupted load.
  `OUTPOST_FAST_RESTORE=0` uses Snapchain's loader instead.
- **client** opens an SSH tunnel to the node and serves the web client on 127.0.0.1:8381. Reads
  and writes both go through your node: the feed is built from its data, and each message you
  sign is submitted to it and relayed from there to the network.

## How it differs from a typical Farcaster app

- **Your own read node.** The client reads from a node you run. A typical app reads through its
  company's servers or a hosted API.
- **A narrow app key.** Logging in adds a gasless app key (`KEY_ADD`) that can only cast, react
  and follow, and undo those. It expires 30 days after last use (`--ttl-days`, 1 to 90, in the
  command-line client).
- **Revoke without the phrase.** The key revokes itself: `./outpost uninstall`, or the
  "Your app key" panel in the web client.
- **A labelled, chronological feed.** The following feed is in time order, and each cast is
  labelled with the app that posted it. You can show only, or hide, any app.
- **Societies (Charter).** A society is a signed `charter.json`: members, moderators, which apps
  to include or exclude, feed rules and a code of conduct link. Loading one applies its lens;
  Join follows its members; Leave drops the lens and keeps your keys, follows and posts. A census
  panel shows members, active members, casts per day and the apps members post from, all
  computed from your node. Examples are in [examples/](examples/).

The client connects an account with a wallet signature or a test account's recovery phrase, and
casts, replies, likes, recasts and follows. The command-line client has the same features:
`./outpost cli --help`.

## Settings

Environment variables:

- `OUTPOST_HOST=<ip>`: use a server you already have instead of the one `provision` made.
- `OUTPOST_SSH_KEY=<path>`: the SSH key for that server.
- `OUTPOST_TUNNEL_PORT` (default 13381): the local end of the SSH tunnel to the node.
  Change it if something on your machine already uses that port.
- `OUTPOST_PORT` (default 8381): where the web client is served.

To use the client from a phone, `./outpost client --phone` serves it from your server over HTTPS
(a certificate for `<ip>.sslip.io`, no domain needed) behind a password, and opens 443/tcp.
`./outpost client --phone off` closes it again.

## Limits

- Outpost does not create accounts or buy storage. Bring an account that already has storage.
- The recovery-phrase login is for test accounts. With a real account, use the wallet path.
- App labels come from the key that signed each cast. Keys that people signed for themselves all
  show as "own key", and a cast whose key is no longer listed shows as "unknown key".
- Casts you write are text up to 1,024 bytes (the limit for a normal account) with up to 4
  embedded URLs. There is no image upload, and an @name you type stays plain text; it does not
  become a mention. There is no notifications view.
- Outpost prints DigitalOcean prices only. New Hetzner accounts can have a volume size limit below
  1.2 TB; ask Hetzner support to raise it if `provision` fails.
- The node costs money for as long as it exists, whether or not you use the client.

## Shard 0 did not load

If `./outpost status` says shard 0's snapshot did not load, `./outpost node` says an earlier load
was interrupted, or logging in fails with `unknown fid`, the node was restarted while
Snapchain's own loader was loading the snapshot. Only nodes that used that loader can get here:
those set up before 19 October 2026, or with `OUTPOST_FAST_RESTORE=0`. The steps to fix it are
in [docs/troubleshooting.md](docs/troubleshooting.md).

## Tests

```
npm ci
npm run typecheck
npm test                         # unit tests, including known test vectors
bash test/providers.sh           # provision and destroy, twice each, against fake doctl and hcloud
bash test/snapshot-restore.sh    # Linux only: the snapshot loader against a local fake bucket
```

CI runs all of these and shellcheck on pull requests and pushes to `main`. Tests against a live node
are in [CONTRIBUTING.md](CONTRIBUTING.md). Outputs from real runs on mainnet and a local devnet
are saved in [docs/evidence/](docs/evidence/README.md).

## Project layout

```
outpost              the CLI: provision, node, client, status, cli, uninstall, destroy
infra/               cloud-init, node setup, snapshot loader, phone access
src/core/            protocol code: node HTTP client, accounts, app keys, writes,
                     feed, app attribution, charters, census (runs in Node and browsers)
src/cli/             command-line client
src/web/             web client
src/server/serve.ts  local server for the web client, forwards /v1 to the node
scripts/             build, devnet end-to-end test, live checks, example charters
test/                unit tests and shell tests, with fake provider CLIs
examples/            example charters and a code of conduct
site/                microsite and tutorial
docs/evidence/       saved outputs from real runs
docs/upstream-prs/   fixes for Snapchain and the Farcaster docs found while building this
```

`npm run build` writes `dist/web`, `dist/serve.js` and `dist/cli.js`. `./outpost client` builds
them when needed.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md). It also lists what Outpost
stores, which ports it opens and the known advisories in its dependencies.

## Licence and credits

MIT. Snapchain is GPL-3.0; Outpost only runs its official Docker image and includes none of its
code. Uses `@farcaster/core` and `viem` (both MIT).

An AI coding assistant helped write this code and its documentation.
