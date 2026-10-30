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

The browser keeps the member's app key in storage for the address `spider333.github.io`. Every
GitHub Pages site of the same author shares that address, this tutorial included, and a script on
any of them could read the key. The build attestation covers only the client's own three files
(`app/index.html`, `app/app.js`, `app/style.css`). So trusting the hosted client means trusting
every page published there. A separate address for the client would close this; it does not have
one yet. With `./outpost client` the key is stored for `127.0.0.1` on your own computer instead.

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
signature must be valid for that hash (`verifyMessage` in `src/core/verify.ts`). Every message the
client shows is rebuilt from those signed bytes; the node's reply is only input to the check and
is never displayed. Pictures are the exception: the signature covers a picture's URL, not the
image its host sends back (see "What picture hosts learn"). A message that fails, or that comes
with any field the signed bytes do not contain, is not shown, and the client says how many it
dropped. The node's own validation is never asked. Test: the malicious-node cases in
`test/verify.test.ts`.

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
- If neither can vouch for a key, for example because the second node is down or switched off,
  the cast is hidden and counted, never reported as passed. The member can choose to show such
  casts for that visit ("Show them anyway", or `--show-unverified` on the command line); they are
  then marked "signer not verified". The member's own app key is always trusted.

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
- **Show a username the account does not own.** The client checks that a username was set with
  one of the account's own keys (`profile` in `src/core/feed.ts`), but not that the account owns
  the name. An honest node rejects such a name; a host's node can serve it, so an account the host
  controls can appear as any @name. A name on someone else's account still needs one of that
  account's keys, checked the same way as the key of a cast.

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

## What picture hosts learn

With "Show pictures" on (the default, except with `--public` or `--node`), the web client loads
profile pictures and image embeds straight from the URLs in signed profiles and casts. Each host learns the reader's IP address and
which of its pictures were shown, so roughly which accounts were on screen. The signature covers
the URL, not the image, so a host can swap the image without changing the signed profile or cast.
A picture cannot change a message or post anything. Only https URLs are loaded, and no referrer
is sent. Untick "Show pictures" above the feed to stop these requests.

## Using Farcaster's public node

`./outpost client --public` (and `cli`, `app-account`) uses Farcaster's public node
`https://snap.farcaster.xyz:3381` instead of your own; `--node <url>` uses any other https node.
That node is in the host's place above: it cannot post as you or change a message, because the
client checks every message the same way (`src/core/verify.ts`), and it can do everything listed
under "What the host can still do". Farcaster sees what you read and post, from your IP address.

- **The second node** for gasless keys is `https://crackle.farcaster.xyz:3381`, another public
  node on a separate machine (`checkNodeFor` in `src/core/secondnode.ts`). Farcaster runs both,
  so a fake gasless key would need only Farcaster to lie. It catches one broken or tampered node,
  not Farcaster itself. The page says so under "What does that change?". Choose another second
  node in "Node and checks", or `--check-node` on the command line.
- **Onchain keys** are still checked on Optimism, as before.
- **Your browser** still talks only to `./outpost client` on 127.0.0.1. It forwards `/v1/*` to
  the node, `/outpost/check/v1/*` (GET only) to the second node and `/outpost/optimism` (POST
  only, read calls such as `eth_call`) to the Optimism RPC (`src/server/serve.ts`, tests in `test/remote-node.test.ts`).
- **No server** is involved: no SSH, no provider (`test/providers.sh` checks with fakes).
- **Posting** goes to the public node like any other submit. It may refuse it; that was not
  tested before release.

## What a society vote proves

A passed amendment is kept in the charter log with the signed proposal and the signed likes that
passed it (`src/core/votes.ts`, tests in `test/votes.test.ts`). A recount (`charter verify`, or
Recount in the web client) checks, from the reader's own node and key sources:

- every signature and hash, so a changed byte anywhere in the log fails;
- that the proposal names the version it changes, and that each version follows the last;
- that the proposer and every approver were members of that version, each counted once;
- that every like is a mainnet like of that exact proposal, signed by a key of the account that
  may sign likes: an onchain key, or a gasless key whose scope includes likes (Snapchain refuses
  other likes, but a hand-made log could contain them);
- that more than half of the members approved.

It does not prove when anyone voted: Farcaster timestamps can be backdated, which is why votes
have no deadline. It cannot re-check a key that was revoked after the vote. Since Snapchain
engine V14 a removed key's old messages stay on the network, so such an approval may be
genuine, but nothing shows it was signed before the key went. A recount labels these approvals,
and says "not recountable from scratch" when the majority rests on them. The client that
accepted the amendment at the time checked those keys then, and keeps its own log. A log from
someone else with such an amendment is only taken after the reader confirms it.

A host cannot vote for a member: a like needs the member's key. A host's node can hide likes or
proposals from a member's view, which delays a pass but cannot fake one. A second log built
from the same founder's charter is shown as a fork, never merged.

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

## What the sponsor sees and keeps

The optional sponsor (`src/server/sponsor.ts` and `sponsor-service.ts`, tests in
`test/sponsor.test.ts`) pays for a member's new Farcaster account:

- The new account's key is made in the member's browser, or stays in their wallet. The sponsor
  gets only the account's address and a signature over it, and sends `IdGateway.registerFor`
  from the host's wallet. The account belongs to the member from the first block: the sponsor
  cannot sign for it, move it or recover it. It sets no recovery address.
- The host can tell which member asked for which new address while the request passes through,
  as with any request to the server. The sponsor logs no address, FID, token or IP address; it
  keeps only how many accounts each member name got.
- Each registration is simulated on Optimism first, so a bad request costs nothing. Caps: 2 per
  member, ever, and 20 a day in all, unless the host changes them.
- The wallet's key lives on the server. Whoever controls the server controls the ETH in it, and
  nothing else.

## Approve in the Farcaster app

For accounts made in the Farcaster app (`src/core/appsignin.ts`, `src/server/appsignin-service.ts`,
tests in `test/appsignin.test.ts`, `scripts/e2e-phase1.ts` on a devnet):

- **The one extra host.** The approval link comes from Farcaster's endpoint
  `https://api.farcaster.xyz` (`POST /v2/signed-key-requests`, then
  `GET /v2/signed-key-request?token=`), with no API key. Only the Outpost server
  (`./outpost client`), the society node's sign-in service, or the CLI (`login --app`) calls it.
  The web page calls only its own origin, or the society node. Farcaster learns the new public
  key, the app account's FID and, once you approve, your FID.
- **What gets added.** An onchain key with full access and no expiry, added by the Farcaster app
  when you approve. Outpost cannot revoke it: only the account's owner can, in the Farcaster app
  (Settings, then Advanced, then Manage connected apps). The page says this before it shows the
  QR code, and the key panel labels such a key.
- **The new key's private half** is made in the browser (or the CLI) and stays there. Only the
  public half goes to the server.
- **The app account's custody key** is entered by its owner in a hidden prompt
  (`./outpost app-account`) and stored mode 600: on the owner's computer, or with `--society`
  only on the society node's server (`$DIR/appsignin/account.json`; `--society off` deletes it).
  It is never sent to a browser, and no response or log carries it or the signature made with
  it (checked in `test/appsignin.test.ts`). Whoever can read that file owns the app account, so
  it should be an account made for this.
- **Who may ask.** `./outpost client` takes a request only from its own page (the browser's
  `Origin`), so another website cannot make it sign. A society node takes requests only with a
  member's token, from the published client origins. Only request tokens the server handed out
  can be polled.
- **Before the key is used**, the client waits until the node lists it as an onchain key
  requested by that app account (`/v1/signer`), and saves it only then.

What a society host can still do here: the host's sign-in service could ask Farcaster to add a
key the host made instead of the one your browser made. The request token is opaque to the page,
so it cannot see which key you are approving; the Farcaster app shows the app asking. Your
browser then never sees its own key listed and says so after 5 minutes, and the host's key would
be on your account with full access until you remove it in the Farcaster app. Use this route only
on a society node whose host you trust, or with your own `./outpost client`, where the server is
your own computer.

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

`--phone` serves the client from your own server at `https://<ip>.sslip.io`, so the phone keeps
its app key in that site's storage. `./outpost destroy` gives the IP back to the provider, and
whoever gets it next can serve a page at the same address that reads the key. Before you destroy
the server, tap "Revoke this key (uninstall)" on the phone.
