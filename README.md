# kit (working name)

Three commands from nothing to your own Snapchain read node and a client for Farcaster
that reads from it and posts through it. No API keys from anyone.

```
./kit provision   # rent a server with a 2 TB disk (DigitalOcean or Hetzner), billed by the hour
./kit node        # start a Snapchain read node on it; first sync takes 2 to 6 hours
./kit client      # open http://127.0.0.1:8080
```

When you are done:

```
./kit uninstall   # revoke the app key; no recovery phrase needed
./kit destroy     # delete the server and stop paying
```

The tutorial is in [site/index.html](site/index.html).

## Before you paste a recovery phrase

A recovery phrase is the custody key of an account. Whoever has it can transfer the account,
add or remove every app key and change the username. Treat pasting it like running
`rm -rf /` as root. Use a test account only, prefer the wallet path, and revoke the key when
you are done. kit uses the phrase in memory to sign one authorization for a scoped,
expiring app key and keeps no copy.

## What you need

- A DigitalOcean (`doctl`) or Hetzner (`hcloud`) account, logged in. Or any Ubuntu 24.04
  server with root SSH and 2 TB of disk: `KIT_HOST=<ip> ./kit node`.
- Node.js 20 or newer, for the client.
- A test account for Farcaster that already has storage.

## What it does

- **provision**: creates a server, a 2 TB volume and a firewall that opens only SSH (22/tcp)
  and gossip (3382/udp). `--dry-run` prints the exact provider commands.
- **node**: runs the official `farcasterxyz/snapchain` image, pinned to 0.14.3, as a read
  node. The HTTP and gRPC ports are bound to 127.0.0.1, because an open node lets anyone
  submit messages through it. It does not use the official installer, which needs a terminal
  and can stop before starting the node (snapchain issue #1030).
- **client**: opens an SSH tunnel to the node and serves the web client on 127.0.0.1:8080.
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

The command-line client has the same features: `./kit cli --help`.

## Layout

```
kit                  the three commands, plus status, cli, uninstall, destroy
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
npx tsc -p .         # typecheck
npm run build        # dist/web, dist/serve.js, dist/cli.js
```

`@farcaster/core` includes test-data factories that depend on `@faker-js/faker`, which has a
published advisory. kit never calls those factories, and the browser and CLI builds replace
faker with a small stand-in (`src/web/faker-stub.ts`).

## Licence and credits

MIT. Snapchain is GPL-3.0; kit only runs its official Docker image and includes none of its
code. Uses `@farcaster/core` and `viem` (both MIT).

An AI coding assistant helped write this code and its documentation.
