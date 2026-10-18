// `kit client` server: serves the static web client and forwards /v1/* to your node.
// Same origin for page and API, so the browser needs no CORS and the node's API port
// never has to face the internet. Binds to 127.0.0.1 unless KIT_BIND says otherwise.
// No dependencies beyond Node itself.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(process.env.KIT_WEB_ROOT ?? join(here, "web"));
const node = new URL(process.env.KIT_NODE_URL ?? "http://127.0.0.1:3381");
const nodeAuth = process.env.KIT_NODE_USER ? "Basic " + Buffer.from(`${process.env.KIT_NODE_USER}:${process.env.KIT_NODE_PASSWORD ?? ""}`).toString("base64") : undefined;
const host = process.env.KIT_BIND ?? "127.0.0.1";
const port = Number(process.env.KIT_PORT ?? 8381);

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

function proxy(req: IncomingMessage, res: ServerResponse) {
  const target = new URL(req.url ?? "/", node);
  const headers: Record<string, string> = {};
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
  if (nodeAuth) headers["authorization"] = nodeAuth;
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const up = send(target, { method: req.method, headers, timeout: 30_000 }, (r) => {
    res.writeHead(r.statusCode ?? 502, { "content-type": r.headers["content-type"] ?? "application/json", "cache-control": "no-store" });
    r.pipe(res);
  });
  up.on("timeout", () => up.destroy(new Error("node did not answer in 30 s")));
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "cannot reach node", error_detail: `${node.origin}: ${e.message}` }));
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
const network = process.env.KIT_NETWORK === "devnet" ? "devnet" : "mainnet";

const server = createServer((req, res) => {
  if (req.url === "/kit-config.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ network }));
  } else if (req.url?.startsWith("/v1/")) proxy(req, res);
  else if (req.method === "GET" || req.method === "HEAD") void serveStatic(req, res);
  else res.writeHead(405).end();
});

server.listen(port, host, () => {
  console.log(`client: http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log(`node:   ${node.origin} (requests to /v1/* are forwarded there)`);
  if (network !== "mainnet") console.log(`network: ${network} (testing only)`);
});
