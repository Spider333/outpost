# AGENTS.md

For AI coding assistants (Claude Code, Codex, Cursor and others) that run Outpost for a person,
or work on its code. People should start with [README.md](README.md).

## Running Outpost for someone

### Rules

1. **Never handle a secret.** Cloud tokens, recovery phrases and custody keys go only into the
   person's own terminal. `doctl auth init`, `hcloud context create`, `./outpost cli login` and
   `./outpost app-account` ask for them in a hidden prompt that needs a real terminal, so leave
   those four commands to the person.
   If a token or phrase is pasted into the chat anyway, say so and stop: the token should be
   revoked, and the account the phrase belongs to should be treated as exposed.
2. **Never invent values.** Server addresses, FIDs, regions, prices and hashes come from command
   output or from the person. If no command printed it, you do not have it.
3. **Say what it costs, then wait for an OK.** `./outpost provision` rents a server that is
   billed by the hour until `./outpost destroy`. The other commands cost nothing extra. You
   cannot answer the yes/no prompts of `provision` and `destroy`, so once the person says OK,
   run them with `--yes`.
4. **Prefer the safe options.** Offer `--dry-run` before `provision` and `destroy`; it prints
   the exact provider commands without running them. For a trial run, use
   `./outpost provision --watchdog 24`: it deletes the server after 24 hours, or after 2 hours
   with no progress.
5. **Keep the node closed.** Do not open the node's API ports or change its firewall. An open
   node lets anyone on the internet submit messages through it. The client reaches the node
   through an SSH tunnel; that is on purpose.
6. **Test accounts only for phrases.** The recovery-phrase login is for a test account. For a
   real account, the web client's "Sign with a wallet" is the path, or for an account made in
   the Farcaster app, "Approve in the Farcaster app".
7. **Say what an approval in the Farcaster app gives away, then wait for an OK.**
   `./outpost cli login --app` (or the web client's "Approve in the Farcaster app") adds an
   onchain key with full access and no expiry that Outpost cannot revoke; the person may pay an
   onchain fee in the app. Tell them that first. Once they say OK, run it with `--yes`; it prints
   a QR code and a link that only the person can approve, on their phone. It needs an app
   account, which the person sets up with `./outpost app-account` (an account made for this,
   never a main account).

### Steps and checkpoints

Run one step at a time and check its output before the next.

| Step | Command | Done when it prints | If not |
|---|---|---|---|
| 0. Check | `doctl account get` (or `hcloud server list`), `node --version` | doctl: the account e-mail. hcloud: a server list, empty is fine. Node 20 or newer | the person logs in to the provider CLI themselves |
| 1. Server | `./outpost provision --watchdog 24 --yes` | `next: ./outpost node` | `422 failed to create volume: invalid size specified`: the DigitalOcean account is limited to smaller volumes. Nothing billable was made. Offer `--provider hetzner` (not yet tested on a real server; say so), or `OUTPOST_HOST=<ip> ./outpost node` on a server they already have |
| 2. Node | `./outpost node` | `synced: every shard is within N blocks of the tip`, then `next: ./outpost client` | see below |
| 3. Client | `./outpost client` | `open http://127.0.0.1:8381 in your browser` | it runs until Ctrl-C, so run it in the background or let the person run it in their own terminal |
| 4. Account | the person, in the browser or with `./outpost cli login`; for an account made in the Farcaster app, `./outpost app-account` once (the person), then "Approve in the Farcaster app" or `./outpost cli login --app --yes` after rule 7 | "Your app key" shows in the web client; `login --app` prints `key 0x… is live for FID …` | the account needs storage; `no app account on this computer`: the person runs `./outpost app-account` |
| 5. Clean up | `./outpost uninstall`, then `./outpost destroy --yes` | `revoked app key …`, then `done. Billing for these resources has stopped.` | a key added in the web client is revoked there: "Your app key", then "Revoke this key (uninstall)". A key approved in the Farcaster app is only forgotten (`this key was approved in the Farcaster app`); the person removes it in the app: Settings, Advanced, Manage connected apps. `./outpost app-account remove` deletes the app account's key |

Step 2 takes 6 to 8 hours. Ctrl-C is safe: the node keeps going on the server, and
`./outpost status` shows where it is. While it runs:

- `loading snapshot: …` or `downloading snapshot: …`: still loading. Check every 15 minutes or so.
- `catching up: furthest shard is N blocks behind`: loading is done and the client already works.
- `cannot reach the server over SSH`: usually a short network drop. Check again in a minute.
- `snapshot load stopped: …`: run `./outpost node` again; it resumes.
- `shard 0 is N blocks behind`: feeds work, adding app keys fails. See "Shard 0 did not load"
  in the README.

`./outpost destroy` and the watchdog only manage a server that `./outpost provision` made. On a
server the person brought with `OUTPOST_HOST`, run `./outpost uninstall` only, and leave
stopping or deleting that server to the person, at its provider.

To check that clean-up worked, list the servers at the provider: `doctl compute droplet list`
or `hcloud server list` should no longer show the Outpost server. Every command is safe to run
twice.

Once an account is connected, `./outpost cli notifications` lists replies, mentions, likes,
recasts and new followers (`--mark-read` clears the new count), and `./outpost cli cast "gm @name"`
posts `@name` as a mention, stopping on a name the node does not know (`--no-mentions` posts it
as text). Neither costs anything.

If the person ran the whole tutorial on their own server, [VOUCHER.md](VOUCHER.md) has a
checklist and a draft cast.

## Working on the code

Setup, and the checks CI runs on every pull request, are in [CONTRIBUTING.md](CONTRIBUTING.md):
`npm ci`, `npm run build`, `npm run typecheck`, `npm test`, `bash test/providers.sh` and
`shellcheck outpost infra/*.sh test/*.sh`.

Keep these properties. [TRUST.md](TRUST.md) and [SECURITY.md](SECURITY.md) explain why.

- The client checks the hash, signature and signing key of every message before showing it
  (`src/core/verify.ts`), and shows only what it rebuilt from the signed bytes.
- The node's HTTP and gRPC ports stay bound to 127.0.0.1.
- The app key can cast, react and follow, and nothing else. It expires, and it revokes itself
  without the recovery phrase. The one exception, a key approved in the Farcaster app, is
  labelled as full access with no expiry everywhere it shows, and the warning comes before the
  QR code.
- The web page talks only to its own origin or the society node. Farcaster's endpoint
  (`api.farcaster.xyz`) is called only by the Outpost server, the society's sign-in service or
  the CLI, and the app account's custody key never reaches a browser, a response or a log.
- A recovery phrase is used in memory only. It is never written to disk or sent anywhere.
- A charter changes only when more than half of its members like a proposal
  (`src/core/votes.ts`). Each passed change keeps the signed likes, so anyone can recount it,
  and a log whose majority cannot be re-checked is used only after the person says so.
- Every `./outpost` command stays safe to run twice.
