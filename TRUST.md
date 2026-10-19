# What a society host can and cannot do

A society node is one Outpost node that several people use. The host runs the server and pays
for it. Members use it for free from a browser or the command line, with their own Farcaster
accounts. This page says what the code stops a host from doing, what it does not stop, and how
a member can check each claim. Every claim names the code that enforces it and the test that
exercises it.

## How members connect

The host runs `./outpost society on` and `./outpost members add <name>`. That prints an invite
link once:

```
https://spider333.github.io/outpost/app/#node=https://<ip>.sslip.io&token=<64 hex characters>
```

The client in that link is built from this repository by a public GitHub Actions workflow
(`.github/workflows/site.yml`), not served by the host. The token sits after `#`, so the browser
never sends it to GitHub. The client stores the node address and token, then removes them from
the address bar (`takeInvite` in `src/core/society.ts`). A member who would rather not trust the
GitHub build runs the same client from their own clone with `./outpost client`.

## What the host cannot do

**Post as a member.** The member's app key is created in their own browser and stays there
(`localStorage`, `src/web/app.ts`). The host never receives it. Posting means the browser signs
the message and sends it through the node, which passes it to the network.

**Change the code a member runs.** In society mode the host's server serves no page and no
JavaScript: its whole web server config is one reverse proxy to the gate (`infra/society.sh`).
The client comes from GitHub Pages, and each build carries a provenance attestation that ties
the served file to the commit it was built from:

```
curl -sO https://spider333.github.io/outpost/app/app.js
gh attestation verify app.js -R Spider333/outpost
```

The commit is also shown at the bottom of the client.

**Alter a message or make one up with someone's real key.** The client checks every message it
reads, in the member's own browser: the hash must match the message content and the Ed25519
signature must be valid for that hash (`verifyMessage` in `src/core/verify.ts`). Everything the
client shows is rebuilt from those signed bytes; the node's reply is only input to the check and
is never displayed. A message that fails, or that comes with any field the signed bytes do not
contain, is not shown, and the client says how many it dropped. The node's own validation is
never asked. Test: the malicious-node cases in `test/verify.test.ts`.

**Answer a question with the wrong data.** Messages must match what was asked for: casts by
account F really are by F, a channel feed really is that channel, a cast looked up by hash
really has that hash (`src/core/hub.ts`). Mismatches are dropped and counted.

**Claim that its own key belongs to someone else.** A valid signature only proves that some key
signed the message. The client also checks that the key belongs to the author:

- Keys added onchain are checked against the KeyRegistry contract on Optimism, through an RPC
  the member picks (default `https://mainnet.optimism.io`; `Optimism` in `src/core/chain.ts`).
- Gasless keys, which every app key added since May 2026 is, have no onchain record, and
  Snapchain's HTTP API does not return the signature that added them. For those the client asks
  a second node the member picks whether the key is one of the author's active keys
  (default `https://snap.farcaster.xyz:3381`, Farcaster's public node; `src/core/secondnode.ts`).
  A cast signed with a key the second node does not list is dropped.

**Lock a member in.** The member's account and app key work with any node. A charter can list
several society nodes (`nodes` in `charter.json`, covered by its signature), and the client lets
the member switch.

## What the host can still do

- **See what members read, and their IP addresses.** TLS ends at the host's server. As published,
  the gate logs only hourly counts per member (`report` in `src/server/gate.ts`), and the web
  server's config turns off its request and error logs, which would otherwise record addresses
  and requested URLs (`infra/society.sh`). But a member cannot see what a host actually runs.
- **Change what runs on the server.** The gate is one file, `src/server/gate.ts` (about 200
  lines, Node built-ins only), copied to the server unchanged, so a host can easily audit their
  own setup. A member cannot check it from outside.
- **Hide things.** Leave out casts, follows or reactions, drop or delay a member's posts, or
  remove a member. Nothing in the client can prove that something is missing. Reading the same
  account through a second node shows the difference.
- **Use a member's access token.** The host sees each token once, when making the invite, so it
  can read through its own node as that member. The token is not a Farcaster key and cannot post.
- **Work with the second node.** If the node a member reads from and the second node both lie,
  a cast signed with a made-up gasless key passes. Choose a second node run by someone else.
- **Fake a follow or a like.** Follows and reactions get the hash and signature checks but not
  the key check.

## What the second node learns

It learns the member's IP address and which accounts' keys the client checks: one request per
account per session, only for keys that Optimism cannot confirm. It does not learn which casts
are read. It can hide real casts by saying a real key is not listed, but it cannot make a fake
cast appear on its own. A key added in the last few minutes may not have reached it yet; its
casts reappear after a reload. Set the second node in the client's "Node and checks" panel, or
with `--check-node <url|off>` on the command line.

Fixing this properly needs Snapchain to return the signature that added each gasless key. The
client could then check it against the account's custody address on Optimism, with no second
node.

## What the gate enforces

The gate (`src/server/gate.ts`, tests in `test/gate.test.ts`) sits between the web server and
the node:

- One token per member. The server stores only SHA-256 hashes of tokens. The token is made on
  the host's computer and only its hash is sent to the server. Missing or unknown token: 401.
- Removing a member takes effect at once, with no restart.
- Only reads (`GET /v1/...`) and message submission (`POST /v1/submitMessage`) reach the node.
  Anything else: 403.
- Rate limits per member, so one member cannot use up another's share. By default 20 reads a
  second (bursts of 100) and 1 submit a second (bursts of 10). Over the limit: 429 with
  `Retry-After`.
- Request bodies over 64 KiB: 413. None of the member's headers are passed to the node.
- Only the published client origins get CORS access.

Any member can check these from outside with their own token:
`scripts/society-check.sh <node URL> <token file>`.

## Running a society node

```
./outpost society on            # opens 443/tcp and starts the gate
./outpost members add alice     # prints alice's invite link, once
./outpost members list
./outpost members remove alice
./outpost society off
```

If the server was not made by `./outpost provision`, open 443/tcp in its firewall yourself.
`--phone` and society mode both use 443, so only one can be on at a time.
