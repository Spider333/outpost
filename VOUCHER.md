# Vouching for Outpost

A vouch is a public cast saying you ran Outpost yourself, on your own server, and what
happened. Failures count as much as successes: say what broke.

## Before you start

- Use **your own** DigitalOcean or Hetzner account. It costs money while the server exists:
  about $0.41 an hour on DigitalOcean at October 2026 list prices, so about $3 for a run of
  6 hours to sync plus an hour of trying it. We have not timed Hetzner yet; your numbers help.
- Start the server with `--watchdog 24`. It deletes the server after 24 hours, or after
  2 hours with no progress, so a forgotten server cannot keep billing you. It runs on your
  computer, so leave the computer on (if it sleeps, the watchdog acts when it wakes).
- To post, use a **test** account for Farcaster, never your main one.
- Keep your recovery phrase, cloud token, server IP and SSH keys out of your cast and out of
  any chat, including AI assistants.

## Checklist

Copy this into a note and fill it in as you go.

```
Commit (git rev-parse --short HEAD):  ________
Provider, server type, region:        ________
./outpost provision --watchdog 24     finished: yes / no    time: ______
./outpost node                        "synced" at: ______   provision to synced: ___ h ___ min
./outpost client                      feed loads from my node: yes / no
Optional, test account only:
  connected (app key added):          yes / no / failed
  cast posted, hash:                  ________   seen in another app: yes / no
  like / follow worked:               yes / no
./outpost uninstall                   key revoked: yes / no
./outpost destroy                     done, provider console shows nothing left: yes / no
Cost shown by the provider:           ________
What broke or confused me:            ________
```

`./outpost node` prints a time on each progress line, so you can read the sync time from it.
`./outpost status` shows progress again if you closed the terminal.

## The cast

Post it publicly, in your own words. A starting point (under 320 bytes):

```
I ran Outpost on my own <provider> server (commit <hash>): own Snapchain read node, synced
in <time>, about $<cost>. The client read my feed from my node. Cast from it: <yes/no>.
Destroy left nothing behind: <yes/no>. Problems: <none / what>.
https://spider333.github.io/outpost/
```

Then send the cast's link to the author, or open an issue on
https://github.com/Spider333/outpost with it, so it can be listed on the site.
