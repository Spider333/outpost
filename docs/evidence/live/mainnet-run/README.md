# Live mainnet run, 2026-10-18

Test account FID 3355358, on our own read node (Snapchain 0.14.3), 22:36 to 22:44 UTC.
The transcripts are the real output. ANSI codes are stripped and one private key line is redacted.

| File | What it shows |
|---|---|
| 01-login.txt | `./kit cli login` through a real terminal: gasless app key added |
| 02-cli.txt | cast, follow, like, recast, the feed with the app filter, Charter join, clean-up, uninstall, and a cast with the revoked key being rejected |
| 03-draft3.txt | upstream draft 3 (docs example) on mainnet; the harness revokes its key |
| 04-draft4.txt | upstream draft 4 (hello world) on mainnet; the harness clears the display name and revokes its key |
| 05-web.txt, web-*.png | web client, phrase path: confirm, authorize, key active on the node, revoke |
| live-test.charter.json | the test charter, signed by the account's custody address |

State on the node after the run:

```
signers: []
links: 0
Like: 0
Recast: 0
casts: ["kit test cast 1: testing a self-hosted client"]
userdata: [{"t":"USER_DATA_TYPE_DISPLAY","v":""}]
```

Cast 1 is kept for the tutorial. Every app key added in the run (four) is revoked.
Before this was committed, every file here was checked for each word of the recovery phrase. None appear.
