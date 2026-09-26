/**
 * SERVICE delivery v1 crypto. Plaintext never uses AUTH_SECRET / secretBox.
 * contentHash = keccak256(plaintext). cipherHash = keccak256(iv || ciphertext||tag).
 * Key wrap is secp256k1 ECIES (ECDH + HKDF-SHA256 + AES-256-GCM), not a server key.
 */
import { keccak256, bytesToHex, hexToBytes } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

export const DELIVER_MAX_BYTES = 32 * 1024 * 1024;
const WRAP_SALT = new TextEncoder().encode("gigsescrow-deliver-v1");
const WRAP_INFO = new TextEncoder().encode("dek");

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function keccakHex(data) {
  const hex = keccak256(bytes(data));
  return hex;
}

export function contentHashOf(plaintext) {
  return keccakHex(plaintext);
}

export function cipherHashOf(blob) {
  return keccakHex(blob);
}

export function canonicalUri({ contentHash, cipherHash, storage, locator }) {
  if (storage !== "disk" && storage !== "r2") throw new Error("storage must be disk or r2");
  if (!/^0x[0-9a-fA-F]{64}$/.test(contentHash)) throw new Error("contentHash must be 0x + 32 bytes");
  if (!/^0x[0-9a-fA-F]{64}$/.test(cipherHash)) throw new Error("cipherHash must be 0x + 32 bytes");
  if (!locator || locator.includes(":")) throw new Error("locator must not contain ':'");
  return `ge1:${contentHash.toLowerCase()}:${cipherHash.toLowerCase()}:${storage}:${locator}`;
}

export function parseCanonical(uri) {
  const parts = String(uri || "").split(":");
  if (parts.length < 5 || parts[0] !== "ge1") return null;
  const contentHash = parts[1];
  const cipherHash = parts[2];
  const storage = parts[3];
  const locator = parts.slice(4).join(":");
  if (storage !== "disk" && storage !== "r2") return null;
  if (!/^0x[0-9a-f]{64}$/.test(contentHash) || !/^0x[0-9a-f]{64}$/.test(cipherHash)) return null;
  if (!locator || locator.includes(":")) return null;
  return { contentHash, cipherHash, storage, locator };
}

function toB64(data) {
  const raw = bytes(data);
  let s = "";
  for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
  return btoa(s);
}

function fromB64(value) {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pubPoint(publicKeyHex) {
  const raw = hexToBytes(publicKeyHex);
  if (raw.length === 33 || raw.length === 65) return raw;
  if (raw.length === 64) {
    const withPrefix = new Uint8Array(65);
    withPrefix[0] = 0x04;
    withPrefix.set(raw, 1);
    return withPrefix;
  }
  throw new Error("public key must be 33 or 65 bytes");
}

export function publicKeyFromPrivate(privateKeyHex) {
  const priv = hexToBytes(privateKeyHex);
  const compressed = secp256k1.getPublicKey(priv, true);
  return bytesToHex(compressed);
}

function wrapKey(sharedX, ephemPub) {
  return hkdf(sha256, sharedX, WRAP_SALT, new Uint8Array([...WRAP_INFO, ...ephemPub]), 32);
}

async function aesGcm(keyBytes, iv, data, decrypt) {
  const key = await crypto.subtle.importKey("raw", bytes(keyBytes), "AES-GCM", false, ["encrypt", "decrypt"]);
  const out = decrypt
    ? await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv) }, key, bytes(data))
    : await crypto.subtle.encrypt({ name: "AES-GCM", iv: bytes(iv) }, key, bytes(data));
  return new Uint8Array(out);
}

/** Blob layout: 12-byte IV || AES-256-GCM ciphertext (tag appended). */
export async function encryptPlaintext(plaintext, dek) {
  const key = dek ? bytes(dek) : randomBytes(32);
  if (key.length !== 32) throw new Error("DEK must be 32 bytes");
  const iv = randomBytes(12);
  const sealed = await aesGcm(key, iv, plaintext, false);
  const blob = new Uint8Array(iv.length + sealed.length);
  blob.set(iv, 0);
  blob.set(sealed, iv.length);
  return { dek: key, blob };
}

export async function decryptCiphertext(blob, dek) {
  const raw = bytes(blob);
  if (raw.length < 12 + 16) throw new Error("ciphertext too short");
  const iv = raw.slice(0, 12);
  const sealed = raw.slice(12);
  return aesGcm(dek, iv, sealed, true);
}

/** base64 of version(1) || ephem compressed(33) || iv(12) || gcm(DEK). */
export async function wrapDek(dek, recipientPublicKeyHex) {
  const pub = pubPoint(recipientPublicKeyHex);
  const ephPriv = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, true);
  const shared = secp256k1.getSharedSecret(ephPriv, pub, true);
  const kek = wrapKey(shared.slice(1), ephPub);
  const iv = randomBytes(12);
  const sealed = await aesGcm(kek, iv, dek, false);
  const out = new Uint8Array(1 + ephPub.length + iv.length + sealed.length);
  out[0] = 1;
  out.set(ephPub, 1);
  out.set(iv, 1 + ephPub.length);
  out.set(sealed, 1 + ephPub.length + iv.length);
  return toB64(out);
}

export async function unwrapDek(wrappedB64, privateKeyHex) {
  const raw = fromB64(wrappedB64);
  if (raw[0] !== 1 || raw.length < 1 + 33 + 12 + 16) throw new Error("bad key wrap");
  const ephPub = raw.slice(1, 34);
  const iv = raw.slice(34, 46);
  const sealed = raw.slice(46);
  const priv = hexToBytes(privateKeyHex);
  const shared = secp256k1.getSharedSecret(priv, ephPub, true);
  const kek = wrapKey(shared.slice(1), ephPub);
  return aesGcm(kek, iv, sealed, true);
}

export function parseDeliverRef(value) {
  if (!value || typeof value !== "object") return null;
  const ref = value;
  if (ref.schemaVersion !== 1 || ref.cipher !== "aes-256-gcm") return null;
  if (ref.storage !== "disk" && ref.storage !== "r2") return null;
  if (ref.keyWrap?.scheme !== "eth-ecies") return null;
  if (typeof ref.keyWrap.buyer !== "string" || typeof ref.keyWrap.seller !== "string") return null;
  if (typeof ref.locator !== "string" || typeof ref.mime !== "string") return null;
  if (!Number.isFinite(ref.size) || ref.size < 0 || ref.size > DELIVER_MAX_BYTES) return null;
  try {
    const canonical = canonicalUri(ref);
    return { ...ref, canonical };
  } catch {
    return null;
  }
}
