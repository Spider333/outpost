// `./outpost client` server: serves the static web client and forwards /v1/* to your node.
// Same origin for page and API, so the browser needs no CORS and the node's API port
// never has to face the internet. Binds to 127.0.0.1 unless OUTPOST_BIND says otherwise.
// No dependencies beyond Node itself.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppAccount } from "../cli/store.js";
import { sameOrigin, signInHandler } from "./appsignin-service.js";
import { DEFAULT_OPTIMISM_RPC } from "../core/chain.js";
import { checkNodeFor, DEFAULT_CHECK_NODE } from "../core/secondnode.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(process.env.OUTPOST_WEB_ROOT ?? join(here, "web"));
const node = new URL(process.env.OUTPOST_NODE_URL ?? "http://127.0.0.1:3381");
const nodeAuth = process.env.OUTPOST_NODE_USER ? "Basic " + Buffer.from(`${process.env.OUTPOST_NODE_USER}:${process.env.OUTPOST_NODE_PASSWORD ?? ""}`).toString("base64") : undefined;
const host = process.env.OUTPOST_BIND ?? "127.0.0.1";
const port = Number(process.env.OUTPOST_PORT ?? 8381);
// A node that is not your own (./outpost client --public or --node <url>): Farcaster's public
// node or someone else's. The page says so, and its key checks go through this server too, so
// the browser still talks only to 127.0.0.1.
const remote = process.env.OUTPOST_NODE_REMOTE === "1";
const optional = (v: string | undefined, fallback: string) => (v === "off" || v === "" ? undefined : new URL(v ?? fallback));
const checkNode = remote ? optional(process.env.OUTPOST_CHECK_NODE, checkNodeFor(node.href)) : undefined;
const rpc = remote ? optional(process.env.OUTPOST_OPTIMISM_RPC, DEFAULT_OPTIMISM_RPC) : undefined;
const CHECK = "/outpost/check";
const RPC = "/outpost/optimism";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  // Scripts only from this origin. Charters may be fetched from any https URL.
  "content-security-policy": "default-src 'self'; img-src * data:; style-src 'self'; script-src 'self'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'",
};

// Forwards the request to base + path; path keeps its query string.
function proxy(req: IncomingMessage, res: ServerResponse, base = node, path = req.url ?? "/", auth = nodeAuth) {
  const target = new URL(base.href.replace(/\/+$/, "") + path);
  const headers: Record<string, string> = {};
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
  if (auth) headers["authorization"] = auth;
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const up = send(target, { method: req.method, headers, timeout: 30_000 }, (r) => {
    res.writeHead(r.statusCode ?? 502, { "content-type": r.headers["content-type"] ?? "application/json", "cache-control": "no-store" });
    r.pipe(res);
  });
  up.on("timeout", () => up.destroy(new Error("node did not answer in 30 s")));
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "cannot reach node", error_detail: `${base.origin}: ${e.message}` }));
  });
  req.pipe(up);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" }).end("bad request");
    return;
  }
  let file = normalize(join(root, path === "/" ? "index.html" : path));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...SECURITY_HEADERS });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

// Which network this client talks to. Mainnet unless testing against a local devnet.
const network = process.env.OUTPOST_NETWORK === "devnet" ? "devnet" : "mainnet";

// "Approve in the Farcaster app": the app account (`./outpost app-account`) signs key requests
// here, and this server, not the page, talks to Farcaster's endpoint. OUTPOST_SIGNIN_API points
// it at a stand-in for tests.
const SIGNIN = "/outpost/app-signin";
const signIn = signInHandler({
  account: () => {
    try {
      return loadAppAccount();
    } catch {
      return undefined; // unreadable: as if none was set up
    }
  },
  api: process.env.OUTPOST_SIGNIN_API || undefined,
  refuse: sameOrigin,
});

function config() {
  if (remote) return { network, node: { url: node.href.replace(/\/+$/, ""), farcaster: node.origin === new URL(DEFAULT_CHECK_NODE).origin, check: checkNode?.origin ?? "", rpc: rpc?.href ?? "" } };
  return network === "devnet" ? { network, checkNode: process.env.OUTPOST_CHECK_NODE ?? "" } : { network };
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  if (path === SIGNIN || path.startsWith(`${SIGNIN}/`)) signIn(req, res, path.slice(SIGNIN.length));
  else if (req.url === "/outpost-config.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(config()));
  } else if (req.url?.startsWith("/v1/")) proxy(req, res);
  // The second node is only read; the RPC only answers JSON-RPC calls.
  else if (checkNode && req.method === "GET" && req.url?.startsWith(`${CHECK}/v1/`)) proxy(req, res, checkNode, req.url.slice(CHECK.length), undefined);
  else if (rpc && req.method === "POST" && path === RPC) proxy(req, res, rpc, "", undefined);
  else if (req.method === "GET" || req.method === "HEAD") void serveStatic(req, res);
  else res.writeHead(405).end();
});

server.listen(port, host, () => {
  console.log(`client: http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log(`node:   ${node.origin} (requests to /v1/* are forwarded there)`);
  if (remote) {
    console.log(`        this is not your own node: it sees what you read and post, and can withhold or delay messages`);
    console.log(`second node for gasless keys: ${checkNode?.origin ?? "off"}; Optimism RPC: ${rpc?.origin ?? "off"} (both through this server)`);
  }
  if (network !== "mainnet") console.log(`network: ${network} (testing only)`);
  let app;
  try {
    app = loadAppAccount();
  } catch {
    console.log("app account: the file from ./outpost app-account cannot be read, so the page cannot offer that sign-in");
  }
  if (app) console.log(`app account: FID ${app.fid} signs "Approve in the Farcaster app" requests (via ${process.env.OUTPOST_SIGNIN_API || "https://api.farcaster.xyz"})`);
});
