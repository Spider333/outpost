# Upstream PR drafts

Local branches in `upstream/` (not pushed, not opened). Opening any of them needs David's yes.
Each must be tested on our node before it is opened. Status column says what has been run.

Already covered by someone else's open PR, so we skip them:
snapchain #1036 (issue #1030), #1041 (bootstrap needs a TTY), #1040 (README requirements),
#1042 (writing-messages profile URL), #1043 and docs #468 (another entrant's tutorial).

| # | Repo / branch | Change | Tested |
|---|---|---|---|
| 1 | snapchain `docs/castsbyfid-pagination-example` | httpapi.md pagination example: `/v1/casts` (no such route) -> `/v1/castsByFid` | route list read from code; live 404/200 check pending sync |
| 2 | snapchain `docs/signer-endpoints` | document `/v1/signer`, `/v1/signersByFid` (HTTP + gRPC), mark `onChainSignersByFid` deprecated | not started: needs real responses from our node |
| 3 | docs `guides/gasless-account-keys` | create-account-key page: gasless KEY_ADD section first, onchain flow kept below | example typechecks with hub-nodejs 0.17.0; live run pending test account |
| 5 | snapchain (issue first, then PR) | `/v1/signersByFid` `requesterFids`: the doc comment says repeat the key (`?requesterFids=1&requesterFids=2`), which the node rejects ("Multiple values for one key"); a single `requesterFids=5` is rejected too ("expected a sequence"); percent-encoded `requesterFids%5B0%5D=5` (what browsers' URLSearchParams send) is silently ignored, so `requesterFidNonces` is missing with no error. Only literal `requesterFids[0]=5` works. Fix options: serde_qs non-strict config, or accept single/repeated values; at minimum fix the comment and docs | reproduced on 0.14.3, see docs/evidence/requesterFids-query-parsing.txt |
| 4 | hub-monorepo `examples/hello-world-gasless-key` | hello-world adds its signer with gasless KEY_ADD instead of a KeyGateway tx + 30 s sleep | typechecks with hub-nodejs 0.17.0; live run pending test account |

## PR text

### 1. docs(httpapi): pagination example uses /v1/castsByFid

The pagination section of the HTTP API page gives `/v1/casts?fid=2&pageSize=3` as an
example. There is no `/v1/casts` route (see the route table in `src/network/http_server.rs`);
the endpoint is `/v1/castsByFid`.

Tested on a v0.14.3 read node:
```
PENDING: curl outputs for both URLs
```

AI disclosure: found while building a tutorial with an AI coding assistant; checked by hand.

### 3. guides: add gasless account keys (KEY_ADD) to create-account-key

This page only shows the Key Gateway flow and asks for ETH and an OP Mainnet RPC. Since
engine V16 (May 2026) account keys can be added with a gasless `KEY_ADD` message, which is
what snapchain's writing-messages guide now teaches (snapchain #989).

This PR adds a "Gasless account keys" section at the top with a short, complete example,
and keeps the existing onchain flow below under "Onchain account keys". It calls out the
two things that trip people up: the `Farcaster KeyAdd` EIP-712 domain (so
`getSignedKeyRequestMetadata` must not be used), and deadlines in Farcaster time.

Tested: the example typechecks against @farcaster/hub-nodejs 0.17.0 and
PENDING: ran against a v0.14.3 read node with a test account (output below).

AI disclosure: drafted with an AI coding assistant, run and checked by a person.

### 4. examples(hello-world): add the signer with a gasless KEY_ADD

The hello-world example still adds its signer with a KeyGateway transaction and then sleeps
30 seconds for hubs to see it. This switches that step to a gasless `KEY_ADD`
(`makeKeyAddBody` + `makeKeyAdd`), scoped to `USER_DATA_ADD` since that is all the example
does, and polls `getSigner` instead of sleeping. FID registration is unchanged (a new FID
still needs a transaction). Bumps the example to @farcaster/hub-nodejs ^0.17.0.

Tested: typechecks against 0.17.0. PENDING: live run output.

AI disclosure: drafted with an AI coding assistant, run and checked by a person.
