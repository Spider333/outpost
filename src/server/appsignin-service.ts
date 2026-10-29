// The server side of "Approve in the Farcaster app" (src/core/appsignin.ts). The page sends only
// a public key; this signs the key request with the app account and asks Farcaster's endpoint
// for the approval link. The app account's key never leaves this process: no response carries
// it, or the signature made with it, and nothing about a request is logged.
//
//   GET  <base>                 {configured, fid?, sponsored?}
//   POST <base>  {key}          {token, deeplinkUrl, deadline, requestFid}
//   GET  <base>/state?token=..  {state: pending | approved | completed | expired, userFid?}
//
// Used by `./outpost client` (src/server/serve.ts, same origin as the page). Only tokens this
// process handed out can be polled, so it is no open relay to Farcaster's endpoint.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { createKeyRequest, isPublicKey, keyRequestState, signKeyRequest, FARCASTER_API, type AppAccount } from "../core/appsignin.js";

export interface SignInOptions {
  account: () => AppAccount | undefined; // read on every request: setup applies without a restart
  api?: string;
  fetch?: typeof fetch;
  now?: () => number; // Unix seconds, for tests
  // Extra rule for each request (e.g. same origin, or a member token). A string refuses it (403).
  refuse?: (req: IncomingMessage) => string | undefined;
  headers?: (req: IncomingMessage) => Record<string, string>;
}

const MAX_BODY = 1024;
// New requests per process: a burst of 10, then one every 6 seconds.
const BURST = 10;
const EVERY_MS = 6_000;

export function signInHandler(opts: SignInOptions) {
  const api = opts.api ?? FARCASTER_API;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const issued = new Map<string, number>(); // token -> deadline
  let tokens = BURST;
  let at = Date.now();

  return (req: IncomingMessage, res: ServerResponse, sub: string) => {
    const extra = opts.headers?.(req) ?? {};
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra }).end(JSON.stringify(body));
    const fail = (status: number, error: string) => send(status, { error });
    const refused = opts.refuse?.(req);
    if (refused) return fail(403, refused);
    const account = opts.account();

    if (req.method === "GET" && sub === "") {
      return send(200, account ? { configured: true, fid: account.fid, sponsored: !!account.sponsor } : { configured: false });
    }
    if (!account) return fail(404, "no app account is set up here. Its owner runs ./outpost app-account once.");

    if (req.method === "GET" && sub === "/state") {
      const token = new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? "";
      const deadline = issued.get(token);
      if (deadline === undefined) return fail(404, "unknown request. Start again.");
      void keyRequestState(token, api, opts.fetch).then(
        (r) => {
          if (r.state !== "completed" && now() > deadline) {
            issued.delete(token);
            return send(200, { state: "expired" });
          }
          if (r.state === "completed") issued.delete(token);
          send(200, { state: r.state, ...(r.userFid ? { userFid: r.userFid } : {}) });
        },
        (e: Error) => fail(502, e.message),
      );
      return;
    }

    if (req.method === "POST" && sub === "") {
      const ms = Date.now();
      tokens = Math.min(BURST, tokens + (ms - at) / EVERY_MS);
      at = ms;
      if (tokens < 1) return fail(429, "too many sign-in requests. Try again in a minute.");
      tokens -= 1;
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c);
      });
      req.on("end", () => {
        if (size > MAX_BODY) return fail(413, "request too large");
        let key: unknown;
        try {
          key = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { key?: unknown }).key;
        } catch {
          return fail(400, "send JSON: {\"key\": \"0x...\"}");
        }
        if (!isPublicKey(key)) return fail(400, "key must be a 32-byte Ed25519 public key in hex");
        void (async () => {
          const body = await signKeyRequest(account, key, now());
          const r = await createKeyRequest(body, api, opts.fetch);
          // Drop requests that can no longer be approved, so the map stays small.
          for (const [t, d] of issued) if (d < now()) issued.delete(t);
          issued.set(r.token, body.deadline);
          send(200, { token: r.token, deeplinkUrl: r.deeplinkUrl, deadline: body.deadline, requestFid: account.fid });
        })().catch((e: Error) => fail(502, e.message));
      });
      return;
    }
    fail(405, "method not allowed");
  };
}

// For `./outpost client`: only the page this server serves may start a request. A browser sends
// Origin with every POST, so another website (or a link) cannot make this server sign for it.
export function sameOrigin(req: IncomingMessage): string | undefined {
  if (req.method !== "POST") return undefined;
  const origin = req.headers.origin;
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return "requests must come from this page";
  const host = req.headers.host;
  if (!origin || !host || (origin !== `http://${host}` && origin !== `https://${host}`)) return "requests must come from this page";
  return undefined;
}

// For a society node (src/server/appsignin.ts behind Caddy at /app-signin): members only, by
// the same Bearer tokens as the gate, from the pages the gate allows (CORS). The page is served
// from another origin there, so the token, not the origin, is what keeps strangers out.
const ORIGINS = new Set(["https://spider333.github.io", "http://127.0.0.1:8381", "http://localhost:8381"]);

export function societySignIn(opts: Omit<SignInOptions, "refuse" | "headers"> & { members: () => Map<string, string> }) {
  const cors = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    return origin && ORIGINS.has(origin) ? { vary: "Origin", "access-control-allow-origin": origin } : { vary: "Origin" };
  };
  const handler = signInHandler({
    ...opts,
    headers: cors,
    refuse: (req) => {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
      const known = token !== undefined && opts.members().has(createHash("sha256").update(token).digest("hex"));
      return known ? undefined : "members only: this needs your access token for the society node";
    },
  });
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (req.method === "OPTIONS") {
      const c = cors(req);
      const allow = c["access-control-allow-origin"] ? { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type" } : {};
      return void res.writeHead(204, { ...c, ...allow }).end();
    }
    if (path !== "/app-signin" && !path.startsWith("/app-signin/")) {
      return void res.writeHead(404, { "content-type": "application/json", ...cors(req) }).end(JSON.stringify({ error: "not found" }));
    }
    handler(req, res, path.slice("/app-signin".length));
  };
}
