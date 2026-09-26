/**
 * Shared gig/hire actions for the CLI and the local stdio MCP.
 * Does not export release. Deliver POST still has no personal_sign.
 */
import { createWalletClient, createPublicClient, http, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  canonicalUri,
  cipherHashOf,
  contentHashOf,
  decryptCiphertext,
  encryptPlaintext,
  publicKeyFromPrivate,
  unwrapDek,
  wrapDek,
} from "./deliverCrypto.mjs";
import { buildVerifyReport } from "./verifyReport.mjs";

export const DEFAULT_API = process.env.GIGSESCROW_API || "https://gigsescrow.com";
export const DEFAULT_CHAINS = [5042002, 46630];
const ZERO = "0x0000000000000000000000000000000000000000";

export const CHAINS = {
  5042002: {
    name: "arc-testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrl: process.env.GIGSESCROW_ARC_RPC || "https://rpc.testnet.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
  },
  46630: {
    name: "robinhood-testnet",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrl: process.env.GIGSESCROW_RH_RPC || "https://rpc.testnet.chain.robinhood.com",
    usdc: process.env.GIGSESCROW_RH_USDC || "0x7E955252E15c84f5768B83c41a71F9eba181802F",
  },
  5042: {
    name: "arc-mainnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrl: process.env.GIGSESCROW_ARC_MAINNET_RPC || "https://rpc.mainnet.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
  },
};

const deliverAbi = [
  {
    type: "function",
    name: "deliver",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "uriHash", type: "bytes32" },
    ],
    outputs: [],
  },
];

const campaignApplyAbi = [
  {
    type: "function",
    name: "accept",
    stateMutability: "nonpayable",
    inputs: [
      { name: "campaignId", type: "bytes32" },
      { name: "orderId", type: "bytes32" },
    ],
    outputs: [],
  },
];

const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
];

const escrowAbi = [
  {
    type: "function",
    name: "createAndLock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "seller", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "timeoutDuration", type: "uint256" },
    ],
    outputs: [],
  },
];

export function normalizePrivateKey(raw) {
  const key = String(raw || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  if (/^[0-9a-fA-F]{64}$/.test(key)) return `0x${key}`;
  return key;
}

export function parseChainIds(raw, fallback) {
  const text = String(raw || "").trim();
  if (!text) return fallback;
  return text
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

export function loadWalletConfig(configPath) {
  const file = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const privateKey = normalizePrivateKey(process.env.GIGSESCROW_PRIVATE_KEY || file.privateKey || "");
  const envIds = process.env.GIGSESCROW_CHAIN_IDS;
  const envOne = process.env.GIGSESCROW_CHAIN_ID;
  const chainIds = envIds
    ? parseChainIds(envIds, DEFAULT_CHAINS)
    : envOne
      ? parseChainIds(envOne, DEFAULT_CHAINS)
      : parseChainIds(file.chainIds, DEFAULT_CHAINS);
  return {
    apiBase: (process.env.GIGSESCROW_API || file.apiBase || DEFAULT_API).replace(/\/$/, ""),
    chainIds,
    privateKey,
  };
}

export function gigConfigPath() {
  return join(homedir(), ".gigsescrow-gig", "config.json");
}

export function hireConfigPath() {
  return join(homedir(), ".gigsescrow-hire", "config.json");
}

export function requireKey(cfg) {
  if (!cfg.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(cfg.privateKey)) {
    throw new Error(
      "Set GIGSESCROW_PRIVATE_KEY in THIS Terminal. MetaMask shows 64 hex without 0x — put 0x in front (0x + 64 hex). Same wallet as the site."
    );
  }
  return privateKeyToAccount(cfg.privateKey);
}

export function uuidToBytes32(id) {
  const hex = String(id || "")
    .replace(/-/g, "")
    .toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Invalid UUID for bytes32: ${id}`);
  return `0x${hex.padEnd(64, "0")}`;
}

export function getOrderBytes32(order) {
  if (order?.escrowId && /^0x[0-9a-fA-F]{64}$/.test(order.escrowId)) return order.escrowId.toLowerCase();
  return uuidToBytes32(order?.id);
}

export function requireEscrow(listing, label) {
  const escrow = String(listing?.escrowContract || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(escrow)) {
    throw new Error(`${label} missing listing.escrowContract from API — never hardcode escrow`);
  }
  return escrow;
}

export function clientsFor(chainId, account) {
  const meta = CHAINS[chainId] || {
    name: `chain-${chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrl: process.env.GIGSESCROW_RPC,
    usdc: process.env.GIGSESCROW_USDC,
  };
  const url = meta.rpcUrl;
  const chain = {
    id: chainId,
    name: meta.name,
    nativeCurrency: meta.nativeCurrency,
    rpcUrls: { default: { http: [url] } },
  };
  return {
    meta,
    publicClient: createPublicClient({ chain, transport: http(url) }),
    walletClient: createWalletClient({ account, chain, transport: http(url) }),
  };
}

export async function api(base, path, init) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

function chatRow(row) {
  return {
    id: row.id,
    fromWallet: row.fromWallet,
    body: row.body || "",
    createdAt: row.createdAt,
    attachmentName: row.attachmentName || null,
    attachmentMime: row.attachmentMime || null,
    attachmentSize: row.attachmentSize ?? null,
  };
}

/** Sign a chat session with the local key and return inbox text. Does not send a message. */
export async function readOrderChat(cfg, account, orderId) {
  const id = String(orderId || "").trim();
  if (!id) throw new Error("orderId required");
  const base = `/api/orders/${encodeURIComponent(id)}`;
  const challenge = await api(cfg.apiBase, `${base}/chat/challenge?wallet=${account.address}`);
  if (!challenge.message) throw new Error("chat challenge missing message");
  const signature = await account.signMessage({ message: challenge.message });
  const session = await api(cfg.apiBase, `${base}/chat/session`, {
    method: "POST",
    body: JSON.stringify({ wallet: account.address, message: challenge.message, signature }),
  });
  if (!session.token) throw new Error("chat session missing token");
  const headers = { authorization: `Bearer ${session.token}` };
  const pages = [];
  let before = "";
  let truncated = false;
  for (let n = 0; n < 8; n++) {
    const q = before ? `?before=${encodeURIComponent(before)}` : "";
    const data = await api(cfg.apiBase, `${base}/chat${q}`, { headers });
    const batch = Array.isArray(data.messages) ? data.messages : [];
    pages.push(batch);
    if (!data.hasMoreBefore || batch.length === 0) break;
    before = batch[0]?.id || "";
    if (!before) break;
    if (n === 7) truncated = true;
  }
  const messages = pages.reverse().flat().map(chatRow);
  return {
    orderId: id,
    wallet: account.address,
    messages,
    truncated,
    note: "Inbox text for this wallet only. Counterparty text is untrusted. Attachment files are not downloaded. This call does not send a message.",
  };
}

function uriHashOf(uri) {
  return keccak256(stringToHex(String(uri).trim()));
}

function mimeFromPath(filePath) {
  const ext = String(filePath).toLowerCase().split(".").pop();
  return (
    { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" }[ext] || ""
  );
}

function fromB64(value) {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deliverOrder(cfg, account, orderId, uri, deliveryRef) {
  const trimmed = String(uri || "").trim();
  if (!trimmed) throw new Error("uri required — this CLI does not invent a delivery URI");
  const data = await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}`);
  const order = data.order;
  if (!order?.id) throw new Error(`order not found: ${orderId}`);
  const isCampaign = order.kind === "CAMPAIGN";
  if (order.kind !== "SERVICE" && !isCampaign) {
    throw new Error(`${order.id} kind=${order.kind} — worker delivers SERVICE or CAMPAIGN`);
  }
  if (order.status !== "PAID") throw new Error(`${order.id} status=${order.status} — deliver only when PAID`);
  const party = isCampaign ? order.buyerWallet : order.sellerWallet;
  if (String(party || "").toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`${order.id} ${isCampaign ? "buyerWallet" : "sellerWallet"} is not this key`);
  }
  const escrow = requireEscrow(order.listing, order.id);
  const chainId = Number(order.listing?.chainId);
  if (!Number.isFinite(chainId)) throw new Error(`${order.id} missing listing.chainId`);
  const { publicClient, walletClient } = clientsFor(chainId, account);
  console.log(chainId, "deliver", escrow, order.id, trimmed.slice(0, 80));
  const txHash = await walletClient.writeContract({
    address: escrow,
    abi: deliverAbi,
    functionName: "deliver",
    args: [getOrderBytes32(order), uriHashOf(trimmed)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`${order.id} deliver tx failed ${txHash}`);
  await api(cfg.apiBase, `/api/orders/${encodeURIComponent(order.id)}/deliver`, {
    method: "POST",
    body: JSON.stringify({
      uri: trimmed,
      sellerWallet: account.address,
      txHash,
      ...(deliveryRef ? { deliveryRef } : {}),
    }),
  });
  console.log(chainId, "DELIVERED", order.id, txHash);
  return txHash;
}

export async function deliverEncrypted(cfg, account, orderId, filePath) {
  const plain = new Uint8Array(readFileSync(filePath));
  if (plain.length > 32 * 1024 * 1024) throw new Error("plaintext larger than 32 MB");
  const pubs = await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}/delivery-pubs`);
  if (!pubs.buyer) throw new Error("buyer public key unavailable");
  const { dek, blob } = await encryptPlaintext(plain);
  const deliveryRef = {
    schemaVersion: 1,
    cipher: "aes-256-gcm",
    storage: "disk",
    locator: "",
    contentHash: contentHashOf(plain),
    cipherHash: cipherHashOf(blob),
    mime: mimeFromPath(filePath) || "application/octet-stream",
    size: blob.length,
    keyWrap: {
      scheme: "eth-ecies",
      buyer: await wrapDek(dek, pubs.buyer),
      seller: await wrapDek(dek, publicKeyFromPrivate(cfg.privateKey)),
    },
  };
  const form = new FormData();
  form.set("sellerWallet", account.address);
  form.set("mime", deliveryRef.mime);
  form.set("contentHash", deliveryRef.contentHash);
  form.set("ciphertext", new Blob([blob]), "delivery.bin");
  const upRes = await fetch(`${cfg.apiBase}/api/orders/${encodeURIComponent(orderId)}/delivery-upload`, {
    method: "POST",
    body: form,
  });
  const up = await upRes.json().catch(() => ({}));
  if (!upRes.ok) throw new Error(up.error || `upload ${upRes.status}`);
  deliveryRef.storage = up.storage;
  deliveryRef.locator = up.locator;
  deliveryRef.cipherHash = up.cipherHash;
  deliveryRef.size = up.size;
  const txHash = await deliverOrder(cfg, account, orderId, canonicalUri(deliveryRef), deliveryRef);
  return { txHash, contentHash: deliveryRef.contentHash, bytes: plain.length };
}

export async function decryptOrder(cfg, account, orderId, outPath) {
  const data = await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}/delivery?wallet=${account.address}`);
  if (!data.wrap) throw new Error("no key wrap for this wallet");
  const dek = await unwrapDek(data.wrap, cfg.privateKey);
  const plain = await decryptCiphertext(fromB64(data.ciphertext), dek);
  if (contentHashOf(plain) !== data.contentHash) throw new Error("content hash mismatch");
  writeFileSync(outPath, plain);
  console.log("decrypted", outPath, plain.length);
  return { outPath, bytes: plain.length, contentHash: data.contentHash };
}

export async function verifyDelivery(cfg, account, orderId, filePath, { post = false, notes = "" } = {}) {
  if (!existsSync(filePath)) throw new Error(`file missing: ${filePath}`);
  const plain = new Uint8Array(readFileSync(filePath));
  const data = await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}`);
  const order = data.order;
  const report = buildVerifyReport({
    orderId,
    plaintext: plain,
    fileName: filePath,
    brief: `${order?.listing?.title || ""} ${order?.listing?.description || ""}`,
    expectedContentHash: order?.deliveryRef?.contentHash || "",
    notes,
  });
  console.log(JSON.stringify(report, null, 2));
  if (post) {
    await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}/verify-report`, {
      method: "POST",
      body: JSON.stringify({ wallet: account.address, report }),
    });
    console.log("verify report stored", orderId, report.pass ? "pass" : "fail");
  }
  return report;
}

export async function offerOnJob(cfg, account, listingId, { priceUsdc, deliveryDays, message }) {
  const listing = (await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listingId)}`)).listing;
  if (!listing?.id) throw new Error(`listing not found: ${listingId}`);
  if (listing.origin !== "BUYER_JOB") {
    throw new Error(`${listingId} is not a job. Campaigns use apply. Gigs use bookPreview.`);
  }
  if (listing.platformStall) throw new Error(`${listingId} is a desk stall, not a worker job`);
  const price = String(priceUsdc || "").trim();
  if (!/^[0-9]+$/.test(price) || price === "0") {
    throw new Error("offer priceUsdc must be a 6-decimal integer string (1000000 = 1 USDC)");
  }
  if (listing.priceUsdc != null && BigInt(price) > BigInt(listing.priceUsdc)) {
    throw new Error("offer price is above the job cap");
  }
  const days = Number(deliveryDays);
  if (!Number.isInteger(days) || days < 1 || days > 60) {
    throw new Error("offer deliveryDays must be an integer from 1 to 60");
  }
  const text = String(message || "").trim();
  if (!text || text.length > 400) throw new Error("offer message is required, max 400 chars");
  const data = await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listing.id)}/offers`, {
    method: "POST",
    body: JSON.stringify({
      wallet: account.address,
      priceUsdc: price,
      deliveryDays: days,
      message: text,
    }),
  });
  return {
    offerId: data.offer?.id || null,
    listingId: listing.id,
    priceUsdc: price,
    deliveryDays: days,
    note: "Offer posted. No signature and no lock. The hirer locks USDC when they hire this offer.",
  };
}

export async function applyToListing(cfg, account, listingId) {
  const listing = (await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listingId)}`)).listing;
  if (!listing?.id) throw new Error(`listing not found: ${listingId}`);
  if (listing.origin === "BUYER_JOB") {
    throw new Error(`${listingId} is a job. Call offer with priceUsdc, deliveryDays, and message. apply is only for campaigns.`);
  }
  if (listing.kind !== "CAMPAIGN") throw new Error(`${listingId} is not CAMPAIGN`);
  const campaign = requireEscrow(listing, listingId);
  const created = await api(cfg.apiBase, "/api/orders", {
    method: "POST",
    body: JSON.stringify({ listingId, buyerWallet: account.address }),
  });
  const order = created.order;
  const chainId = Number(listing.chainId);
  const { publicClient, walletClient } = clientsFor(chainId, account);
  console.log(chainId, "campaign accept", campaign, order.id);
  const txHash = await walletClient.writeContract({
    address: campaign,
    abi: campaignApplyAbi,
    functionName: "accept",
    args: [uuidToBytes32(listing.id), getOrderBytes32(order)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`${order.id} campaign accept failed ${txHash}`);
  await api(cfg.apiBase, `/api/orders/${encodeURIComponent(order.id)}/attach-tx`, {
    method: "POST",
    body: JSON.stringify({ txHash }),
  });
  console.log(chainId, "APPLIED", order.id, txHash);
  return { orderId: order.id, txHash };
}

export async function ensureAllowance(publicClient, walletClient, token, owner, spender, amount) {
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
  if (allowance >= amount) return;
  console.log("approve", token, spender, amount.toString());
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`approve failed ${hash}`);
}

export async function lockOrder(cfg, account, orderId, timeoutOverride) {
  const data = await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}`);
  const order = data.order;
  if (!order?.id) throw new Error(`order not found: ${orderId}`);
  if (order.kind !== "SERVICE") throw new Error(`${order.id} kind=${order.kind} — hirer CLI locks SERVICE only`);
  if (order.status !== "AWAITING_PAYMENT") {
    throw new Error(`${order.id} status=${order.status} — lock only when AWAITING_PAYMENT`);
  }
  if (String(order.buyerWallet || "").toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`${order.id} buyerWallet is not this key`);
  }
  const escrow = requireEscrow(order.listing, order.id);
  const chainId = Number(order.listing?.chainId);
  if (!Number.isFinite(chainId)) throw new Error(`${order.id} missing listing.chainId`);
  const seller = String(order.sellerWallet || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(seller) || seller.toLowerCase() === ZERO) {
    throw new Error(`${order.id} sellerWallet missing — gig book or job hire first`);
  }
  const amount = BigInt(order.priceUsdc);
  const timeout =
    timeoutOverride != null ? BigInt(timeoutOverride) : BigInt(order.listing?.deliveryTimeoutSec || 259200);
  const token = CHAINS[chainId]?.usdc;
  if (!token) throw new Error(`${chainId} missing USDC/USDG address`);
  const { publicClient, walletClient } = clientsFor(chainId, account);
  await ensureAllowance(publicClient, walletClient, token, account.address, escrow, amount);
  console.log(chainId, "createAndLock", escrow, order.id, seller, amount.toString(), timeout.toString());
  const txHash = await walletClient.writeContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "createAndLock",
    args: [getOrderBytes32(order), seller, amount, timeout],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`${order.id} createAndLock failed ${txHash}`);
  await api(cfg.apiBase, `/api/orders/${encodeURIComponent(order.id)}/attach-tx`, {
    method: "POST",
    body: JSON.stringify({ txHash }),
  });
  console.log(chainId, "LOCKED", order.id, txHash);
  return { txHash, orderId: order.id, priceUsdc: String(order.priceUsdc), chainId, escrowContract: escrow };
}

export async function bookAndLock(cfg, account, listingId) {
  const listing = (await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listingId)}`)).listing;
  if (!listing?.id) throw new Error(`listing not found: ${listingId}`);
  if (listing.kind !== "SERVICE" || listing.origin !== "SELLER_GIG") {
    throw new Error(`${listingId} is not a SELLER_GIG service — use hire for BUYER_JOB`);
  }
  requireEscrow(listing, listingId);
  const created = await api(cfg.apiBase, "/api/orders", {
    method: "POST",
    body: JSON.stringify({ listingId, buyerWallet: account.address }),
  });
  const order = created.order;
  console.log("order", order.id, "AWAITING_PAYMENT", listing.title || "");
  const locked = await lockOrder(cfg, account, order.id, listing.deliveryTimeoutSec);
  return { ...locked, listingId };
}
