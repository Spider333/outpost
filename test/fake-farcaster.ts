// A stand-in for Farcaster's signed key request endpoint (api.farcaster.xyz/v2/signed-key-...),
// for tests and the demo. It checks the app account's EIP-712 SignedKeyRequest signature (and a
// sponsorship, when sent) the way the KeyGateway would, then "approves" when told to, or after
// `autoApproveAfter` polls, calling `onApprove` so a fake node can list the new onchain key.

import { createServer, type Server } from "node:http";
import { SIGNED_KEY_REQUEST_TYPE, SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN } from "@farcaster/core";
import { verifyMessage, verifyTypedData } from "viem";
import type { HexString, KeyRequestBody } from "../src/core/index.js";

export interface FakeRequest {
  body: KeyRequestBody;
  token: string;
  state: "pending" | "approved" | "completed";
  polls: number;
  userFid?: number;
}

export async function fakeFarcaster(opts: {
  appAddress: HexString;
  userFid: number;
  autoApproveAfter?: number; // polls; undefined: only approve() does it
  onApprove?: (r: FakeRequest) => void;
}): Promise<{ url: string; requests: FakeRequest[]; approve: (token: string) => void; close: () => void; server: Server }> {
  const requests: FakeRequest[] = [];
  const approve = (token: string) => {
    const r = requests.find((x) => x.token === token);
    if (!r || r.state === "completed") return;
    r.state = "completed";
    r.userFid = opts.userFid;
    opts.onApprove?.(r);
  };
  const out = (r: FakeRequest) => ({
    result: { signedKeyRequest: { token: r.token, deeplinkUrl: `farcaster://signed-key-request?token=${r.token}`, key: r.body.key, state: r.state, ...(r.userFid ? { userFid: r.userFid } : {}) } },
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.method === "POST" && url.pathname === "/v2/signed-key-requests") {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as KeyRequestBody;
        const ok = await verifyTypedData({
          address: opts.appAddress,
          domain: SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN,
          types: { SignedKeyRequest: SIGNED_KEY_REQUEST_TYPE },
          primaryType: "SignedKeyRequest",
          message: { requestFid: BigInt(body.requestFid), key: body.key, deadline: BigInt(body.deadline) },
          signature: body.signature,
        }).catch(() => false);
        if (!ok) return send(400, { errors: [{ message: "invalid signature" }] });
        if (body.sponsorship && !(await verifyMessage({ address: opts.appAddress, message: { raw: body.signature }, signature: body.sponsorship.signature }).catch(() => false))) {
          return send(400, { errors: [{ message: "invalid sponsorship" }] });
        }
        const r: FakeRequest = { body, token: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex")}`, state: "pending", polls: 0 };
        requests.push(r);
        return send(200, out(r));
      }
      if (req.method === "GET" && url.pathname === "/v2/signed-key-request") {
        const r = requests.find((x) => x.token === url.searchParams.get("token"));
        if (!r) return send(404, { errors: [{ message: "not found" }] });
        r.polls++;
        if (opts.autoApproveAfter !== undefined && r.polls >= opts.autoApproveAfter) approve(r.token);
        return send(200, out(r));
      }
      send(404, { errors: [{ message: "not found" }] });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, approve, close: () => server.close(), server };
}
