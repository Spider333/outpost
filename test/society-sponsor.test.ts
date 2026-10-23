// infra/society.sh sponsor-on / sponsor-off with a fake docker: the Caddy routes, the wallet key
// (made once, kept, 0600), and the container's flags. No real docker or server is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../infra/society.sh", import.meta.url));
const WALLET = "0x1111111111111111111111111111111111111111";

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_DIR/calls"
running="$FAKE_DIR/running"
case "$1" in
  inspect)
    if [ "$2" = "-f" ]; then echo running; exit 0; fi
    grep -qx "$2" "$running" 2>/dev/null ;;
  run)
    case "$*" in
      *"caddy validate"*) exit 0 ;;
      *randomBytes*) echo "0x$(printf 'ab%.0s' $(seq 1 32))" ;;
      *"--name outpost-sponsor"*) [ -z "$FAKE_SPONSOR_FAIL" ] || exit 125; echo outpost-sponsor >>"$running"; echo id ;;
      *) echo id ;;
    esac ;;
  logs) echo "sponsor: wallet ${WALLET} on Optimism; 127.0.0.1:3391" ;;
  rm) shift; [ "$1" = "-f" ] && shift; for n in "$@"; do grep -vx "$n" "$running" >"$running.tmp" 2>/dev/null; mv "$running.tmp" "$running" 2>/dev/null; done; exit 0 ;;
  *) exit 0 ;;
esac
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "society-"));
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(dir, "running"), "outpost-society\noutpost-gate\n");
  const run = (action: string, stdin = "", extra: Record<string, string> = {}) =>
    spawnSync("bash", [SCRIPT, action], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, OUTPOST_SOCIETY_DIR: join(dir, "srv"), OUTPOST_SOCIETY_HOST: "1-2-3-4.sslip.io", ...extra },
    });
  return { dir, run, caddy: () => readFileSync(join(dir, "srv/caddy/Caddyfile"), "utf8"), calls: () => readFileSync(join(dir, "calls"), "utf8") };
}

test("sponsor-on: makes the wallet key once, routes /sponsor/* to the sponsor and the rest to the gate", () => {
  const s = setup();
  try {
    const on = s.run("sponsor-on", "// bundle");
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, new RegExp(`send a little ETH on Optimism to ${WALLET}`));
    const key = join(s.dir, "srv/sponsor/key");
    assert.match(readFileSync(key, "utf8").trim(), /^0x[0-9a-f]{64}$/);
    assert.equal(statSync(key).mode & 0o777, 0o600);
    const caddy = s.caddy();
    assert.match(caddy, /handle \/sponsor\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:3391\n\t\}/);
    assert.match(caddy, /handle \{\n\t\treverse_proxy 127\.0\.0\.1:3390\n\t\}/);
    assert.match(caddy, /exclude http\.log http\.handlers http\.stdlib tls\.handshake/);
    const run = s.calls().split("\n").find((l) => l.includes("--name outpost-sponsor"))!;
    for (const flag of ["--read-only", "--cap-drop ALL", "no-new-privileges", "/sponsor/key:ro", "--network host", "OUTPOST_SPONSOR_MEMBERS=/gate/members"]) {
      assert.ok(run.includes(flag), `missing ${flag}`);
    }
    // The folder, not the file: `members add` moves a new file into place, and a file mount would
    // keep showing the sponsor the old one.
    assert.ok(run.includes(`${join(s.dir, "srv/gate")}:/gate:ro`), "the gate folder is mounted");
    assert.ok(!run.includes("members:/gate/members"), "the members file is not mounted on its own");
    assert.match(s.calls(), /exec outpost-society caddy reload/);

    // Again: same key (it may hold ETH), new bundle.
    const before = readFileSync(key, "utf8");
    assert.equal(s.run("sponsor-on", "// bundle 2").status, 0);
    assert.equal(readFileSync(key, "utf8"), before);
    assert.equal(readFileSync(join(s.dir, "srv/sponsor/sponsor.js"), "utf8"), "// bundle 2");

    // Off: the gate gets every request again; the key stays.
    const off = s.run("sponsor-off");
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(s.caddy(), /sponsor/);
    assert.match(s.caddy(), /^\treverse_proxy 127\.0\.0\.1:3390$/m);
    assert.ok(existsSync(key));
  } finally {
    rmSync(s.dir, { recursive: true });
  }
});

test("sponsor-on refuses without society mode and without a bundle", () => {
  const s = setup();
  try {
    writeFileSync(join(s.dir, "running"), "");
    assert.match(s.run("sponsor-on", "// bundle").stderr, /society mode is off/);
    writeFileSync(join(s.dir, "running"), "outpost-society\n");
    assert.match(s.run("sponsor-on", "").stderr, /no sponsor bundle/);
  } finally {
    rmSync(s.dir, { recursive: true });
  }
});

test("a sponsor that fails to start (re)starting gives every request back to the gate", () => {
  const s = setup();
  try {
    assert.equal(s.run("sponsor-on", "// bundle").status, 0);
    assert.match(s.caddy(), /handle \/sponsor\/\*/);
    const again = s.run("sponsor-on", "// broken bundle", { FAKE_SPONSOR_FAIL: "1" });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /could not start the sponsor container/);
    assert.doesNotMatch(s.caddy(), /sponsor/);
    assert.ok(!existsSync(join(s.dir, "srv/sponsor/on")));
    assert.ok(existsSync(join(s.dir, "srv/sponsor/key")), "the wallet key is kept");
  } finally {
    rmSync(s.dir, { recursive: true });
  }
});

test("society on keeps the sponsor route while the sponsor is on", () => {
  const s = setup();
  try {
    assert.equal(s.run("sponsor-on", "// bundle").status, 0);
    const on = s.run("on", "// gate source");
    assert.equal(on.status, 0, on.stderr);
    assert.match(s.caddy(), /handle \/sponsor\/\*/);
  } finally {
    rmSync(s.dir, { recursive: true });
  }
});
