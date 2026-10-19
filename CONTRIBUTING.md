# Contributing

Bug reports and pull requests are welcome. For a security problem, follow [SECURITY.md](SECURITY.md)
instead of opening an issue.

## Setup

Node.js 20 or newer, then:

```
npm ci
npm run build      # dist/web, dist/serve.js, dist/cli.js
```

## Checks

CI runs each of these on every pull request ([.github/workflows/test.yml](.github/workflows/test.yml)):

```
npm run typecheck
npm test                          # unit tests in test/*.test.ts
bash test/providers.sh            # the outpost CLI against fake provider CLIs
bash test/snapshot-restore.sh     # infra/snapshot-restore.sh against a fake bucket; Linux only
shellcheck outpost infra/*.sh test/*.sh
```

`test/providers.sh` puts the fake `doctl` and `hcloud` from `test/fake-providers/` first on the
`PATH`. They keep resources as files in a temporary folder, so the test runs `provision` and
`destroy` twice for each provider without an account and without creating anything. They also
copy DigitalOcean quirks seen in real runs, such as a volume left detached at create and a
deleted volume that is still listed.

`test/snapshot-restore.sh` serves a fake snapshot from 127.0.0.1 with `python3 -m http.server`
and needs `jq`, `curl` and GNU coreutils. It does not run on macOS.

## Tests against a node

These need Docker or a synced node, so CI does not run them.

- `scripts/e2e-devnet.ts`: the whole client flow against a local Snapchain devnet. The commands to
  start and stop the devnet are at the top of the file.
- `./outpost cli selftest`: signs every message type with throwaway keys and asks your node to
  validate them. It submits nothing.
- `scripts/live-checks.sh`: reads from a synced mainnet node and saves the output to
  `docs/evidence/live/`.

## Rules

- **The `outpost` script runs on bash 3.2**, the version macOS ships as `/bin/bash`. No
  associative arrays, `mapfile`/`readarray`, `${var,,}` or other bash 4 features. To check on a
  Mac, run the provider test with the system bash first on the `PATH`:
  `PATH="/bin:$PATH" bash test/providers.sh`. The scripts in `infra/` run on Ubuntu 24.04 servers
  and may use bash 5 and GNU tools.
- **Every output in the docs comes from a real run.** If you change what a command prints, or add
  output to the README or the site, run it and save the transcript under `docs/evidence/`, with the
  command and the UTC time on the first line and ANSI codes stripped.
- **No secrets in saved output.** Use throwaway or test accounts. Before committing a transcript,
  check it for every word of any recovery phrase used, and for private keys.
- Keep changes small and say in the pull request how you tested them.
