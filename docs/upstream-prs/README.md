# Upstream PR drafts

Fixes for Snapchain, the Farcaster docs and the hub-monorepo examples, found while building
Outpost. The drafts with a branch name are branches in local clones of the upstream repos (the
`upstream/` folder, which is not part of this repo). Each is tested on our node before it is
opened, and the Tested column says what has been run.

Opened on 20 Oct 2026:
- 1: [snapchain #1055](https://github.com/farcasterxyz/snapchain/pull/1055)
- 4: [hub-monorepo #2745](https://github.com/farcasterxyz/hub-monorepo/pull/2745), with yarn.lock regenerated
- 5: issue [snapchain #1056](https://github.com/farcasterxyz/snapchain/issues/1056)
- 6: issue [snapchain #1057](https://github.com/farcasterxyz/snapchain/issues/1057)

Opened on 21 Oct 2026:
- 8: [snapchain #1067](https://github.com/farcasterxyz/snapchain/pull/1067), fixes issue #1030 (#1036 was closed unmerged by its author on 20 Oct)
- 9: [snapchain #1068](https://github.com/farcasterxyz/snapchain/pull/1068)

Not opened: 2 overlaps snapchain #1049 and 3 overlaps docs #470 (both opened by others on
19 Oct); 7 is not compiled yet.

Already covered by someone else's open PR, so we skip them:
snapchain #1041 (bootstrap needs a TTY), #1040 (README requirements), #1042 (writing-messages
profile URL), #1053 (running-a-node cost), #1043 and docs #468 (another entrant's tutorial).

| # | Repo / branch | Change | Tested |
|---|---|---|---|
| 1 | snapchain `docs/castsbyfid-pagination-example` | httpapi.md pagination example: `/v1/casts` (no such route) -> `/v1/castsByFid` | route list read from code; 404 vs 200 checked on our mainnet read node (docs/evidence/live/upstream-1-casts-route.txt) |
| 2 | snapchain `docs/signer-endpoints` | document `/v1/signer`, `/v1/signersByFid` (HTTP + gRPC) with the `requesterFids[0]=` syntax (#5 folded in), mark `onChainSigner*` deprecated, fix the http_server.rs doc comment | written; example responses are real, from a local 0.14.3 devnet (one onchain and one gasless key on one FID). Query parsing re-checked on our mainnet node (same results); site build not run |
| 3 | docs `guides/gasless-account-keys` | create-account-key page: gasless KEY_ADD section first, onchain flow kept below | typechecks with hub-nodejs 0.17.0; the example as written (constants and network swapped) adds a key on a local 0.14.3 devnet: docs/evidence/upstream-examples-devnet.txt. On mainnet with test FID 3355358 it adds the key on a 0.14.3 read node: docs/evidence/live/mainnet-run/03-draft3.txt |
| 5 | snapchain (issue first, then PR) | `/v1/signersByFid` `requesterFids`: the doc comment says repeat the key (`?requesterFids=1&requesterFids=2`), which the node rejects ("Multiple values for one key"); a single `requesterFids=5` is rejected too ("expected a sequence"); percent-encoded `requesterFids%5B0%5D=5` (what browsers' URLSearchParams send) is silently ignored, so `requesterFidNonces` is missing with no error. Only literal `requesterFids[0]=5` works. Fix options: serde_qs non-strict config, or accept single/repeated values; at minimum fix the comment and docs | reproduced on 0.14.3, see docs/evidence/requesterFids-query-parsing.txt |
| 6 | snapchain (tiny) | HTTP JSON for onchain events has `"tier_purchase_event_body": null` (snake_case, never skipped) next to camelCase fields; `http_server.rs` `OnChainEvent.tier_purchase_event_body` lacks `#[serde(rename = "tierPurchaseEventBody", skip_serializing_if = "Option::is_none")]` like its siblings. Changing it renames a JSON field, so it needs a maintainer's call; open as an issue first | seen in /v1/signersByFid output on 0.14.3 |
| 4 | hub-monorepo `examples/hello-world-gasless-key` | hello-world adds its signer with gasless KEY_ADD instead of a KeyGateway tx + 30 s sleep | typechecks with hub-nodejs 0.17.0; new signer step adds a key and a USER_DATA_ADD merges on a local 0.14.3 devnet (docs/evidence/upstream-examples-devnet.txt). On mainnet with test FID 3355358 the same: docs/evidence/live/mainnet-run/04-draft4.txt. yarn.lock not regenerated yet |
| 7 | snapchain `http/signer-key-add-proof` | Return the stored KEY_ADD message with each gasless signer on `/v1/signer`, `/v1/signersByFid` and the matching gRPC calls (HTTP `keyAddMessage`, gRPC `Signer.key_add_message = 13`), so clients can check the custody signature themselves instead of trusting the node or a second node; additive only | not compiled yet (no Rust toolchain where it was written); the proto file checks with protoc; 1 new test and 2 updated test checks, not run |
| 8 | snapchain `fix/upgrade-without-operator-fid` | `snapchain.sh upgrade` no longer exits before starting the node when `HUB_OPERATOR_FID=0`: `setup_crontab` picks a random weekday instead of `exit 1`, and a numeric FID is kept as typed instead of becoming 0 when it has no fname | A/B in a throwaway ubuntu:24.04 container (real bash, cron, curl, jq; docker and Grafana stubbed): main exits 1 and never starts the node for FID 0 and for FID 3355358, the fix exits 0 and starts it; usernames still resolve; table in the PR |
| 9 | snapchain `docs/channel-endpoints` | New HTTP and gRPC Channels API pages for the 13 channel routes/RPCs (`channelOwner` ... `isFollowingChannel`), with a warning that channels need engine V21, which is only scheduled on devnet | every example is real output from a local 4-validator 0.14.3 devnet (channels, members, pin, moderation and follows created through the admin RPC and signed messages); all 13 routes checked over HTTP and gRPC; mainnet behaviour checked on our read node; `vocs build` passes |

Seen on mainnet, already being handled upstream, so no draft from us:
- `castsByParent` (all-shard reads) always returns a `nextPageToken`; the last one decodes to
  `[null,null]`, and sending it back restarts every shard from page 1, so a client that follows
  tokens loops forever. A shard that runs out before the others restarts too, which repeats its
  casts. Open PR #720 fixes the first part. Outpost treats an all-null token as the end
  (`liveToken` in src/core/hub.ts). Checked 2026-10-18.
- Corrected 2026-10-18: the snapshot does include shard 0, loaded last. Our node's shard 0
  was empty because we restarted the container mid-load, and snapchain skips the snapshot
  once `.rocks` has data. With shard 0 behind, `KEY_ADD` is rejected as "unknown fid" (keys
  are routed to and checked on shard 0), and the data shards fail to replay shard 0's key
  events into their replicas (90 failed on our node). Possible upstream issue: a partial load
  is not detected on restart. Outpost now guards against the restart and counts shard 0 in "synced".

## PR text

### 1. docs(httpapi): pagination example uses /v1/castsByFid

The pagination section of the HTTP API page gives `/v1/casts?fid=2&pageSize=3` as an
example. There is no `/v1/casts` route (see the route table in `src/network/http_server.rs`);
the endpoint is `/v1/castsByFid`.

Tested on a v0.14.3 mainnet read node:
```
$ curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3381/v1/casts?fid=2&pageSize=3'
404
$ curl -s 'http://127.0.0.1:3381/v1/castsByFid?fid=2&pageSize=3' | jq '.messages | length'
3
```

AI disclosure: found while building a tutorial with an AI coding assistant; checked by hand.

### 2. docs: document /v1/signer and /v1/signersByFid; mark onChainSigner* deprecated

The HTTP and gRPC reference pages document only `onChainSignersByFid` /
`GetOnChainSigner(sByFid)`. `rpc.proto` marks those deprecated ("gasless / off-chain keys
are not surfaced"), and the unified `signer` / `signersByFid` endpoints that replace them
are not documented anywhere except one line of the writing-messages guide.

This adds both endpoints to both pages, with the response fields and which source sets
them, and marks the old ones deprecated. It also documents how to pass `requesterFids`:
the doc comment in `http_server.rs` says to repeat the key, but the node parses queries
with serde_qs in strict mode, so on v0.14.3:

```
$ curl -g 'http://127.0.0.1:3381/v1/signersByFid?fid=3&requesterFids=9152&requesterFids=1&pageSize=1'
Invalid query parameters: Multiple values for one key: "requesterFids"
$ curl -g 'http://127.0.0.1:3381/v1/signersByFid?fid=3&requesterFids=9152&pageSize=1'
Invalid query parameters: invalid type: string "9152", expected a sequence
$ curl -g 'http://127.0.0.1:3381/v1/signersByFid?fid=3&requesterFids%5B0%5D=9152&pageSize=1' | jq -c '{currentUserNonce, requesterFidNonces}'
{"currentUserNonce":0,"requesterFidNonces":null}
$ curl -g 'http://127.0.0.1:3381/v1/signersByFid?fid=3&requesterFids[0]=9152&pageSize=1' | jq -c '{currentUserNonce, requesterFidNonces}'
{"currentUserNonce":0,"requesterFidNonces":{"9152":0}}
```

The percent-encoded form is accepted and ignored, so `requesterFidNonces` is just missing.

I fixed that comment too. Changing the parser (non-strict serde_qs, or accepting a single
value) would be friendlier for browsers, whose URLSearchParams always percent-encodes
brackets; happy to do that in a separate PR if you want it.

Tested: example responses are real output from a v0.14.3 node (a local devnet with one
onchain and one gasless key on the same FID). The query-parsing results above are from a
mainnet read node, same version.

AI disclosure: drafted with an AI coding assistant; every response was produced by running
the node, and checked by a person.

### 3. guides: add gasless account keys (KEY_ADD) to create-account-key

This page only shows the Key Gateway flow and asks for ETH and an OP Mainnet RPC. Since
engine V16 (May 2026) account keys can be added with a gasless `KEY_ADD` message, which is
what snapchain's writing-messages guide now teaches (snapchain #989).

This PR adds a "Gasless account keys" section at the top with a short, complete example,
and keeps the existing onchain flow below under "Onchain account keys". It calls out the
two things that trip people up: the `Farcaster KeyAdd` EIP-712 domain (so
`getSignedKeyRequestMetadata` must not be used), and deadlines in Farcaster time.

Tested: the example typechecks against @farcaster/hub-nodejs 0.17.0, and run as written
(only the constants and network changed) it adds a key on a local snapchain 0.14.3 devnet,
and on mainnet through a 0.14.3 read node with a test account.

AI disclosure: drafted with an AI coding assistant, run and checked by a person.

### 4. examples(hello-world): add the signer with a gasless KEY_ADD

The hello-world example still adds its signer with a KeyGateway transaction and then sleeps
30 seconds for hubs to see it. This switches that step to a gasless `KEY_ADD`
(`makeKeyAddBody` + `makeKeyAdd`), scoped to `USER_DATA_ADD` since that is all the example
does, and polls `getSigner` instead of sleeping. FID registration is unchanged (a new FID
still needs a transaction). Bumps the example to @farcaster/hub-nodejs ^0.17.0.

Tested: typechecks against 0.17.0. On a local snapchain 0.14.3 devnet (FID registered
through the admin RPC instead of OP) the new signer step adds the key and the example's
USER_DATA_ADD merges with it. The same on mainnet through a 0.14.3 read node with a test
account. PENDING: regenerate yarn.lock for the version bump.

AI disclosure: drafted with an AI coding assistant, run and checked by a person.
