import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { blake3 } from "@noble/hashes/blake3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { decodeGaslessSignedKeyRequestMetadata, MessageData, MessageType, ViemLocalEip712Signer, type Message } from "@farcaster/core";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex, hexToBytes } from "viem";
import { buildKeyAdd, buildSelfRevoke, custodyFromSeedPhrase, DEFAULT_SCOPES, farcasterNow, publicKeyOf, unwrap } from "../src/core/index.js";

// Known vector: the Hardhat/Foundry test mnemonic, account 0 at m/44'/60'/0'/0/0.
const TEST_PHRASE = "test test test test test test test test test test test junk";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Known vector: RFC 8032 section 7.1, test 1.
const RFC8032_SECRET = "0x9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC8032_PUBLIC = "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

// ---- Independent EIP-712 implementation (no viem typed-data code), mirroring
// snapchain src/core/validations/key.rs: domain {name, version, chainId}, no verifyingContract.
const enc = new TextEncoder();
const k = (b: Uint8Array) => keccak_256(b);
const u256 = (n: bigint | number) => hexToBytes(`0x${BigInt(n).toString(16).padStart(64, "0")}`);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};
const domainSeparator = k(
  cat(
    k(enc.encode("EIP712Domain(string name,string version,uint256 chainId)")),
    k(enc.encode("Farcaster KeyAdd")),
    k(enc.encode("1")),
    u256(1),
  ),
);
const digest = (structHash: Uint8Array) => k(cat(new Uint8Array([0x19, 0x01]), domainSeparator, structHash));

function keyAddDigest(m: { fid: number; key: Uint8Array; keyType: number; scopes: number[]; ttl: number; nonce: number; deadline: number }) {
  const typeHash = k(enc.encode("KeyAdd(uint256 fid,bytes key,uint32 keyType,uint32[] scopes,uint32 ttl,uint32 nonce,uint256 deadline)"));
  return digest(
    k(cat(typeHash, u256(m.fid), k(m.key), u256(m.keyType), k(cat(...m.scopes.map(u256))), u256(m.ttl), u256(m.nonce), u256(m.deadline))),
  );
}

function signedKeyRequestDigest(m: { requestFid: bigint; key: Uint8Array; deadline: bigint }) {
  const typeHash = k(enc.encode("SignedKeyRequest(uint256 requestFid,bytes key,uint256 deadline)"));
  return digest(k(cat(typeHash, u256(m.requestFid), k(m.key), u256(m.deadline))));
}

function recoverAddress(hash: Uint8Array, sig: Uint8Array): string {
  assert.equal(sig.length, 65);
  const v = sig[64]!;
  const pub = secp256k1.Signature.fromCompact(sig.slice(0, 64))
    .addRecoveryBit(v >= 27 ? v - 27 : v)
    .recoverPublicKey(hash)
    .toRawBytes(false);
  return bytesToHex(k(pub.slice(1)).slice(12));
}

function checkEnvelope(msg: Message, expectedSigner: Uint8Array) {
  const dataBytes = msg.dataBytes && msg.dataBytes.length > 0 ? msg.dataBytes : MessageData.encode(msg.data!).finish();
  assert.deepEqual(msg.hash, blake3(dataBytes, { dkLen: 20 }), "hash is blake3-160 of the data bytes");
  assert.deepEqual(msg.signer, expectedSigner, "envelope signer");
  assert.ok(ed25519.verify(msg.signature, msg.hash, msg.signer), "Ed25519 signature over the hash verifies");
}

const FIXED_KEY = hexToBytes(RFC8032_SECRET);
const NOW = farcasterNow(); // the SDK checks the deadline against the real clock
const FID = 424242;

test("seed phrase derives the known custody address at m/44'/60'/0'/0/0", () => {
  assert.equal(custodyFromSeedPhrase(TEST_PHRASE).address, TEST_ADDRESS);
  // Extra spaces and capitals are tolerated, word count is checked.
  assert.equal(custodyFromSeedPhrase(`  ${TEST_PHRASE.toUpperCase()}  `).address, TEST_ADDRESS);
  assert.throws(() => custodyFromSeedPhrase("test test test"), /12 or 24 words/);
});

test("Ed25519 app key matches RFC 8032 test 1", async () => {
  assert.equal(bytesToHex(await publicKeyOf(FIXED_KEY)), RFC8032_PUBLIC);
});

test("KEY_ADD: custody signature recovers to the custody address under the gasless domain", async () => {
  const custody = custodyFromSeedPhrase(TEST_PHRASE);
  const { message, key } = await buildKeyAdd({ fid: FID, custody: custody.signer, nonce: 7, privateKey: FIXED_KEY, now: NOW });
  const data = message.data!;
  assert.equal(data.type, MessageType.KEY_ADD);
  assert.equal(data.fid, FID);
  assert.equal(data.timestamp, NOW);
  const body = data.keyAddBody!;
  assert.equal(bytesToHex(body.key), RFC8032_PUBLIC);
  assert.equal(body.keyType, 1);
  assert.equal(body.metadataType, 1);
  assert.equal(body.nonce, 7);
  assert.equal(body.ttl, 30 * 86400);
  assert.equal(body.deadline, NOW + 3600, "deadline is Farcaster time + 1h, not Unix time");
  assert.deepEqual(body.scopes, DEFAULT_SCOPES);

  const recovered = recoverAddress(
    keyAddDigest({ fid: FID, key: body.key, keyType: 1, scopes: body.scopes, ttl: body.ttl, nonce: body.nonce, deadline: body.deadline }),
    body.custodySignature,
  );
  assert.equal(recovered.toLowerCase(), TEST_ADDRESS.toLowerCase());

  // The SignedKeyRequest metadata names the requesting app (here: the user's own FID).
  const meta = unwrap(decodeGaslessSignedKeyRequestMetadata(body.metadata));
  assert.equal(meta.requestFid, BigInt(FID));
  assert.equal(meta.requestSigner.toLowerCase(), TEST_ADDRESS.toLowerCase());
  assert.equal(meta.deadline, BigInt(NOW + 3600));
  const reqSigner = recoverAddress(signedKeyRequestDigest({ requestFid: meta.requestFid, key: body.key, deadline: meta.deadline }), meta.signature);
  assert.equal(reqSigner.toLowerCase(), TEST_ADDRESS.toLowerCase());

  // The envelope is signed by the new key itself (proof of possession).
  checkEnvelope(message, body.key);
  assert.equal(key.publicKey, RFC8032_PUBLIC);
  assert.equal(key.requestFid, FID);
});

test("KEY_ADD: the onchain-domain signature would NOT recover (guards against the wrong helper)", async () => {
  const custody = custodyFromSeedPhrase(TEST_PHRASE);
  const { message } = await buildKeyAdd({ fid: FID, custody: custody.signer, nonce: 1, privateKey: FIXED_KEY, now: NOW });
  const body = message.data!.keyAddBody!;
  const meta = unwrap(decodeGaslessSignedKeyRequestMetadata(body.metadata));
  // Onchain SignedKeyRequestValidator domain: chainId 10 plus verifyingContract.
  const onchainDomain = k(
    cat(
      k(enc.encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
      k(enc.encode("Farcaster SignedKeyRequestValidator")),
      k(enc.encode("1")),
      u256(10),
      u256(BigInt("0x00000000FC700472606ED4fA22623Acf62c60553")),
    ),
  );
  const typeHash = k(enc.encode("SignedKeyRequest(uint256 requestFid,bytes key,uint256 deadline)"));
  const wrong = k(cat(new Uint8Array([0x19, 0x01]), onchainDomain, k(cat(typeHash, u256(meta.requestFid), k(body.key), u256(meta.deadline)))));
  assert.notEqual(recoverAddress(wrong, meta.signature).toLowerCase(), TEST_ADDRESS.toLowerCase());
});

test("KEY_ADD: separate app FID signs the key request with its own custody key", async () => {
  const user = custodyFromSeedPhrase(TEST_PHRASE);
  const appAccount = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // Hardhat account 1
  const app = new ViemLocalEip712Signer(appAccount);
  const { message, key } = await buildKeyAdd({ fid: FID, custody: user.signer, nonce: 2, requestFid: 9999, requestSigner: app, now: NOW });
  const meta = unwrap(decodeGaslessSignedKeyRequestMetadata(message.data!.keyAddBody!.metadata));
  assert.equal(meta.requestFid, 9999n);
  assert.equal(meta.requestSigner.toLowerCase(), appAccount.address.toLowerCase());
  assert.equal(key.requestFid, 9999);
  await assert.rejects(buildKeyAdd({ fid: FID, custody: user.signer, nonce: 2, requestFid: 9999 }), /custody signer/);
});

test("KEY_ADD: rejects empty scopes and TTL outside 1s..90d before signing", async () => {
  const custody = custodyFromSeedPhrase(TEST_PHRASE);
  await assert.rejects(buildKeyAdd({ fid: FID, custody: custody.signer, nonce: 1, scopes: [] }), /at least one scope/);
  await assert.rejects(buildKeyAdd({ fid: FID, custody: custody.signer, nonce: 1, ttl: 0 }), /ttl/);
  await assert.rejects(buildKeyAdd({ fid: FID, custody: custody.signer, nonce: 1, ttl: 90 * 86400 + 1 }), /ttl/);
  await assert.doesNotReject(buildKeyAdd({ fid: FID, custody: custody.signer, nonce: 1, ttl: 90 * 86400, now: NOW }));
});

test("self-revoke KEY_REMOVE is signed by the key itself, no custody signature", async () => {
  const custody = custodyFromSeedPhrase(TEST_PHRASE);
  const { key } = await buildKeyAdd({ fid: FID, custody: custody.signer, nonce: 1, privateKey: FIXED_KEY, now: NOW });
  const msg = await buildSelfRevoke(key, 1, NOW);
  const body = msg.data!.keyRemoveBody!;
  assert.equal(msg.data!.type, MessageType.KEY_REMOVE);
  assert.equal(body.signatureType, 2);
  assert.equal(body.signature.length, 0);
  assert.equal(body.nonce, 1);
  assert.equal(bytesToHex(body.key), RFC8032_PUBLIC);
  checkEnvelope(msg, hexToBytes(RFC8032_PUBLIC));
});

test("signatures are deterministic (RFC 6979 / Ed25519), so this vector is stable", async () => {
  const custody = custodyFromSeedPhrase(TEST_PHRASE);
  const a = await buildKeyAdd({ fid: FID, custody: custody.signer, nonce: 7, privateKey: FIXED_KEY, now: NOW });
  const b = await buildKeyAdd({ fid: FID, custody: custody.signer, nonce: 7, privateKey: FIXED_KEY, now: NOW });
  assert.equal(bytesToHex(a.message.hash), bytesToHex(b.message.hash));
  assert.equal(bytesToHex(a.message.data!.keyAddBody!.custodySignature), bytesToHex(b.message.data!.keyAddBody!.custodySignature));
});
