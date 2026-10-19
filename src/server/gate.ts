// Society node gate: runs on the host's server between Caddy (TLS) and the Snapchain node, so
// members can use the node from their own browsers. This file is every rule the server applies
// to a member's request and everything it records about them. It runs as it is (Node strips the
// types; no build step, no dependencies), so the copy on a server can be compared byte for byte
// with the one in the repository.
//
// - Every request except a CORS preflight needs `Authorization: Bearer <token>`, else 401. The
//   members file holds one "<name> <SHA-256 hex of the token>" line per member, never a token.
// - Only GET /v1/* and POST /v1/submitMessage reach the node. Anything else: 403.
// - Each member has one token bucket for reads and one for submits. Over it: 429 + Retry-After.
// - Request bodies are capped at 64 KiB (413). The member's headers are not passed to the node.
// - Nothing about a request is logged: no path, query, body, token or IP address. Once an hour
//   (and when it stops) it prints one line per member: requests forwarded, refused, rate-limited.
//
// Environment: OUTPOST_GATE_MEMBERS (members file), OUTPOST_GATE_PORT (3390, 127.0.0.1 only),
// OUTPOST_GATE_UPSTREAM (http://127.0.0.1:3381), OUTPOST_GATE_READ_RATE and _READ_BURST (20 per
// second, burst 100), OUTPOST_GATE_SUBMIT_RATE and _SUBMIT_BURST (1 per second, burst 10).
// SIGHUP reads the members file again; `./outpost members` sends it after every change.

import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const membersFile = process.env.OUTPOST_GATE_MEMBERS ?? "/gate/members";
const port = Number(process.env.OUTPOST_GATE_PORT ?? 3390);
const upstream = new URL(process.env.OUTPOST_GATE_UPSTREAM ?? "http://127.0.0.1:3381");
const MAX_BODY = 64 * 1024;
const ORIGINS = new Set(["https://spider333.github.io", "http://127.0.0.1:8381", "http://localhost:8381"]);

function setting(name: string, fallback: number): number {
  const v = Number(process.env[name] || fallback);
  if (!(v > 0)) throw new Error(`${name} must be a number above 0`);
  return v;
}
const LIMITS = {
  read: { rate: setting("OUTPOST_GATE_READ_RATE", 20), burst: setting("OUTPOST_GATE_READ_BURST", 100) },
  submit: { rate: setting("OUTPOST_GATE_SUBMIT_RATE", 1), burst: setting("OUTPOST_GATE_SUBMIT_BURST", 10) },
};
type Kind = keyof typeof LIMITS;

// SHA-256 (hex) of each member's token -> member name.
let members = new Map<string, string>();

function loadMembers() {
  const next = new Map<string, string>();
  try {
    for (const line of readFileSync(membersFile, "utf8").split("\n")) {
      const m = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,39})\s+([0-9a-f]{64})$/.exec(line.trim());
      if (m) next.set(m[2]!, m[1]!);
    }
  } catch (e) {
    // Fails closed: without a readable members file nobody gets in.
    console.log(`cannot read the members file (${(e as NodeJS.ErrnoException).code ?? "error"}); nobody can connect`);
  }
  members = next;
  console.log(`members: ${next.size}`);
}

// Requests per member since the last report. This is all the gate keeps about members.
type Tally = { reads: number; submits: number; refused: number; limited: number };
const tallies = new Map<string, Tally>();
let unknown = 0;

function tally(name: string): Tally {
  let t = tallies.get(name);
  if (!t) tallies.set(name, (t = { reads: 0, submits: 0, refused: 0, limited: 0 }));
  return t;
}

function report() {
  const at = new Date().toISOString();
  for (const [name, t] of tallies) {
    console.log(`${at} ${name}: ${t.reads} reads, ${t.submits} submits, ${t.refused} refused, ${t.limited} rate-limited`);
  }
  if (unknown) console.log(`${at} no or unknown token: ${unknown}`);
  tallies.clear();
  unknown = 0;
}

const buckets = new Map<string, { tokens: number; at: number }>();

// Takes one request from the member's bucket. Returns 0, or the seconds until one is free.
function take(name: string, kind: Kind): number {
  const { rate, burst } = LIMITS[kind];
  const now = performance.now();
  const key = `${kind} ${name}`;
  const b = buckets.get(key) ?? { tokens: burst, at: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens < 1) return Math.ceil((1 - b.tokens) / rate);
  b.tokens -= 1;
  return 0;
}

// Every response is JSON, and a browser that opens one directly runs nothing in it.
const HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || !ORIGINS.has(origin)) return { vary: "Origin" };
  // Retry-After is exposed so the client can read it on a 429.
  return { vary: "Origin", "access-control-allow-origin": origin, "access-control-expose-headers": "Retry-After" };
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const cors = corsHeaders(req);
  const reply = (status: number, error: string, extra: Record<string, string> = {}) =>
    res.writeHead(status, { ...HEADERS, ...cors, ...extra }).end(JSON.stringify({ error }));

  if (req.method === "OPTIONS") {
    // CORS preflight: no token, and nothing reaches the node.
    const allow = cors["access-control-allow-origin"]
      ? { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type" }
      : {};
    res.writeHead(204, { ...cors, ...allow }).end();
    return;
  }

  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
  const name = token === undefined ? undefined : members.get(createHash("sha256").update(token).digest("hex"));
  if (name === undefined) {
    unknown++;
    return reply(401, "missing or unknown token");
  }

  // The parsed path (dot segments resolved) is both what is checked and what is sent on.
  let url: URL | undefined;
  try {
    if (req.url?.startsWith("/")) url = new URL(`http://gate${req.url}`);
  } catch {}
  const kind: Kind | undefined =
    req.method === "GET" && url?.pathname.startsWith("/v1/") ? "read"
    : req.method === "POST" && url?.pathname === "/v1/submitMessage" ? "submit"
    : undefined;
  if (!url || !kind) {
    tally(name).refused++;
    return reply(403, "only GET /v1/* and POST /v1/submitMessage are allowed");
  }
  const wait = take(name, kind);
  if (wait) {
    tally(name).limited++;
    return reply(429, "rate limit", { "retry-after": String(wait) });
  }

  const tooLarge = () => {
    tally(name).refused++;
    reply(413, "request body over 64 KiB", { connection: "close" });
  };
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size <= MAX_BODY) chunks.push(c);
    else if (!res.headersSent) tooLarge();
  });
  req.on("end", () => {
    if (size > MAX_BODY) return;
    const body = Buffer.concat(chunks);
    // Only a submit carries a body, and only its content type goes with it.
    const headers: Record<string, string> =
      kind === "submit"
        ? { "content-type": req.headers["content-type"] ?? "application/octet-stream", "content-length": String(body.length) }
        : {};
    tally(name)[kind === "read" ? "reads" : "submits"]++;
    const up = request(new URL(url.pathname + url.search, upstream), { method: req.method, headers, timeout: 30_000 }, (r) => {
      res.writeHead(r.statusCode ?? 502, { ...HEADERS, ...cors });
      r.pipe(res);
    });
    up.on("timeout", () => up.destroy(new Error("timeout")));
    up.on("error", () => {
      if (!res.headersSent) reply(502, "cannot reach the node");
      else res.destroy();
    });
    up.end(kind === "submit" ? body : undefined);
  });
}

loadMembers();
process.on("SIGHUP", loadMembers);
for (const s of ["SIGTERM", "SIGINT"] as const) {
  process.on(s, () => {
    report();
    process.exit(0);
  });
}
setInterval(report, 3600_000).unref();

const server = createServer(handle);
server.listen(port, "127.0.0.1", () => {
  const a = server.address();
  const { read, submit } = LIMITS;
  console.log(
    `gate: 127.0.0.1:${a && typeof a === "object" ? a.port : port} -> ${upstream.origin}; per member: ` +
      `reads ${read.rate}/s (burst ${read.burst}), submits ${submit.rate}/s (burst ${submit.burst})`,
  );
});
