# Evidence

Saved output from real runs. Each text file starts with the command it ran and when.

| Path | What it is |
|---|---|
| [live/outpost-tutorial/](live/outpost-tutorial/README.md) | Every output shown on the tutorial page, run on mainnet against our read node on 2026-10-18 |
| [live/mainnet-run/](live/mainnet-run/README.md) | The first live mainnet run with a test account: login, cast, follow, like, recast, feed, Charter, revoke, plus web client screenshots |
| `live/status.txt`, `live/feed-37*.txt`, `live/upstream-*.txt` | Written by [scripts/live-checks.sh](../../scripts/live-checks.sh) against our mainnet node: sync status, a following feed with the app filter, and the checks behind the upstream drafts |
| `live/charter-verify.txt`, `live/census-vs-manual.txt`, `live/web-charter.txt` | Charter on mainnet: signature check, census compared with an independent count by [scripts/manual-census.sh](../../scripts/manual-census.sh), the web client's society panel |
| `e2e-devnet-0.14.3.txt` | [scripts/e2e-devnet.ts](../../scripts/e2e-devnet.ts) against a local Snapchain 0.14.3 devnet |
| `cli-devnet-0.14.3.txt`, `web-devnet-0.14.3.txt` | Command-line and web client against a local devnet |
| `ui-*.png` | Web client screenshots, on a local devnet and on mainnet |
| `selftest-local-0.14.3.txt` | `selftest`: every message type signed with throwaway keys and validated by a local node |
| `upstream-examples-devnet.txt`, `requesterFids-query-parsing.txt` | Checks for the drafts in [docs/upstream-prs](../upstream-prs/README.md) |
| `kit-dry-run.txt`, `kit-dry-run-fresh-machine.txt` | `provision --dry-run` on a machine without doctl, and on a fresh machine with no SSH key and no provider CLI |

Everything outside `live/outpost-tutorial/` was recorded before the project was renamed from kit
to Outpost: `./kit` is now `./outpost` and `kit-client` is `./outpost cli`. Older runs also show
older defaults; `kit-dry-run.txt`, for example, shows a 2 TiB volume where the default is now
1.2 TB.
