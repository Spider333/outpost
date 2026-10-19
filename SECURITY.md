# Security

## Reporting a vulnerability

Please report it privately through GitHub: open the repository's Security tab and choose
"Report a vulnerability" (https://github.com/Spider333/outpost/security/advisories/new).
Do not open a public issue for it.

Include what an attacker could do, the steps to reproduce, and the commit you tested. Never
include a real recovery phrase, app key or password; a throwaway account is enough to show a bug.

Outpost has no releases yet. Fixes go to `main`.

## What is sensitive

**Recovery phrase.** The phrase controls the account. Outpost asks for one only on the
recovery-phrase login path, which is meant for test accounts. It derives the custody address in
memory, signs one `KEY_ADD` authorization for a scoped, expiring app key, and drops the phrase.
It never writes the phrase to disk and never sends it over the network. The command-line prompt
hides input and refuses to run without a terminal (`src/cli/prompt.ts`); the web client clears
the input field as soon as it reads it (`src/web/app.ts`). The wallet path never sees the phrase.

**App keys.** An app key can cast, react and follow (and undo those) for one account, and nothing
else. It expires 30 days after last use by default. Whoever holds it can post as that account
until it is revoked or expires.

- The command-line client stores it in `~/.config/outpost/appkey.json` (under
  `$XDG_CONFIG_HOME/outpost` or `$OUTPOST_HOME` if either is set), directory mode 700, file
  mode 600.
- The web client stores it in the browser's localStorage under `outpost.appkey`.
- `./outpost uninstall`, or the web client's "Your app key" panel, revokes it with the key itself.

**Node API ports.** Snapchain's HTTP (3381) and gRPC (3383) ports accept writes from anyone who
can reach them. `infra/node-setup.sh` binds both to 127.0.0.1 and checks the result after every
run; it stops with an error if either is published anywhere else. The client reaches the node
through an SSH tunnel. The firewall that `./outpost provision` creates opens only 22/tcp (SSH)
and 3382/udp (gossip).

**Local client server.** `dist/serve.js` binds to 127.0.0.1 unless `OUTPOST_BIND` is set, and
forwards every `/v1` request, writes included, to your node. Do not bind it to a public address.

**Phone access.** `./outpost client --phone` opens 443/tcp on the server and puts a password in
front of every request, including `/v1`. The password is kept in `.outpost/phone-password`.
`./outpost client --phone off` removes it and closes the port. On a server Outpost did not
create, open and close 443/tcp in its firewall yourself.

**SSH.** Outpost keeps server host keys in `.outpost/known_hosts` and trusts the first key it sees
for a new server (`StrictHostKeyChecking=accept-new`). The `.outpost/` folder is mode 700 and is
in `.gitignore`.

## Known advisories in dependencies

`npm audit` reports 4 high-severity entries (checked 2026-10-19). They come from two packages; the
other two entries are the packages that depend on them.

- `@faker-js/faker` 7.6.0, [GHSA-qxc2-j82w-r537](https://github.com/advisories/GHSA-qxc2-j82w-r537),
  in `helpers.fake`. It comes from `@farcaster/core` 0.20.0, whose test-data factories import
  faker. Those factories call `helpers.arrayElement` and other generators but never
  `helpers.fake`, and Outpost never uses their output. The web and CLI builds replace faker with a
  small stand-in (`src/web/faker-stub.ts`), so `dist/` contains no faker code.
- `@grpc/grpc-js` 1.11.4, [GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j)
  and [GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4). It comes from
  `@farcaster/hub-nodejs`, a dev dependency used only by `scripts/e2e-devnet.ts` against a local
  devnet. None of the client builds include it.
