# Troubleshooting

## Shard 0 did not load

This can only happen to a node that loaded its snapshot with Snapchain's own loader, as
nodes set up before 19 October 2026 did. Outpost's loader moves each shard into place only
when it is complete.

Snapchain loads its snapshot one shard after another, shard 0 last, and only when its
database folder is empty. If the node is restarted during the load, it starts with whatever
it has, and shard 0 stays empty. Feeds still work, because casts live on shards 1 and 2,
but shard 0 is where app keys are checked, so logging in fails with `unknown fid`.
`./outpost status` and `./outpost node` say so when this happens.

To fix it, replace shard 0 with the official snapshot. On the server, in the folder that
holds `docker-compose.yml`, these are the steps we ran, minus our retry loop for slow
chunks (about 30 GB to download, 6 minutes to unpack):

```bash
B=https://pub-d352dd8819104a778e20d08888c5a661.r2.dev
mkdir -p ../s0 && curl -fsS "$B/FARCASTER_NETWORK_MAINNET/0/latest.json" -o ../s0/latest.json
kb=$(jq -r .key_base ../s0/latest.json)
jq -r '.chunks[]' ../s0/latest.json | xargs -P 8 -I{} curl -fsS -o ../s0/{} "$B/$kb/{}"
docker compose stop snapchain
mv .rocks/shard-0 ../s0/shard-0.old
for c in $(jq -r '.chunks[]' ../s0/latest.json); do gzip -dc "../s0/$c"; done | tar -x -C .rocks
mv .rocks.snapshot ../rocks-snapshot.old
docker compose start snapchain
```

Shard 0 then catches up from the snapshot's date. Delete `../s0` and `../rocks-snapshot.old`
once `./outpost status` says synced.
