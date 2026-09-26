#!/usr/bin/env node
/**
 * Gig worker + FILE/TOKEN seller CLI. No LLM auto-work. No browser automation.
 *
 *   node gigsescrow-gig.mjs init
 *   node gigsescrow-gig.mjs watch
 *   node gigsescrow-gig.mjs deliver --order <uuid> --uri <string>
 *   node gigsescrow-gig.mjs deliver --order <uuid> --file <path>
 *   node gigsescrow-gig.mjs decrypt --order <uuid> --out <path>
 *   node gigsescrow-gig.mjs arb-wrap --order <uuid>
 *   node gigsescrow-gig.mjs verify-delivery --order <uuid> --file <decrypted path> [--post]
 *   node gigsescrow-gig.mjs list-file --file <path> --preview <img> --title "…" --description "…" --price <6dec>
 *   node gigsescrow-gig.mjs grant-file --order <uuid>
 *   node gigsescrow-gig.mjs decrypt-listing --order <uuid> --out <path>
 *   node gigsescrow-gig.mjs list-token --token 0x… --amount <int> --price <6dec> --title "…" --description "…" [--lock]
 *
 * Env: GIGSESCROW_PRIVATE_KEY, GIGSESCROW_API
 * Optional: GIGSESCROW_CHAIN_ID (one chain) or GIGSESCROW_CHAIN_IDS=5042002,46630
 * Auto-deliver (default OFF): --uri-file or GIGSESCROW_DELIVER_URI. Watch never invents a URI.
 *
 * Always listing.escrowContract from GET. Never hardcode escrow.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import {
  api,
  applyToListing,
  clientsFor,
  decryptOrder,
  verifyDelivery,
  deliverEncrypted,
  deliverOrder,
  getOrderBytes32,
  loadWalletConfig,
  requireEscrow,
  requireKey,
  uuidToBytes32,
} from "./lib/gigsescrow-core.mjs";

const CONFIG_DIR = join(homedir(), ".gigsescrow-gig");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DEFAULT_API = process.env.GIGSESCROW_API || "https://gigsescrow.com";
const DEFAULT_CHAINS = [5042002, 46630];
const POLL_MS = 15_000;

const CHAINS = {
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

const acceptAbi = [
  {
    type: "function",
    name: "accept",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "seller", type: "address" },
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
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
];

const lotAbi = [
  {
    type: "function",
    name: "createAndLock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "listingId", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "tokenAmount", type: "uint256" },
      { name: "priceUsdc", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancel",
    stateMutability: "nonpayable",
    inputs: [{ name: "listingId", type: "bytes32" }],
    outputs: [],
  },
];

function normalizePrivateKey(raw) {
  const key = String(raw || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  if (/^[0-9a-fA-F]{64}$/.test(key)) return `0x${key}`;
  return key;
}

function parseChainIds(raw, fallback) {
  const text = String(raw || "").trim();
  if (!text) return fallback;
  return text
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

function flagValue(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return "";
  const next = process.argv[i + 1];
  if (String(next).startsWith("-")) return "";
  return String(next);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function flagValues(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== name || i + 1 >= process.argv.length) continue;
    const next = process.argv[i + 1];
    if (String(next).startsWith("-")) continue;
    out.push(String(next));
  }
  return out;
}

function mimeFromPath(filePath) {
  const ext = String(filePath).toLowerCase().split(".").pop();
  return (
    {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
    }[ext] || ""
  );
}

function loadConfig() {
  return loadWalletConfig(CONFIG_PATH);
}

function uriHashOf(uri) {
  return keccak256(stringToHex(String(uri).trim()));
}

function loadAutoDeliverUri() {
  const file = flagValue("--uri-file");
  if (file) {
    if (!existsSync(file)) throw new Error(`--uri-file not found: ${file}`);
    return readFileSync(file, "utf8").trim();
  }
  return String(process.env.GIGSESCROW_DELIVER_URI || "").trim();
}

function printRubric() {
  console.log(`
Worker CLI (gig / job / campaign / FILE+TOKEN seller — no auto-work)
  SERVICE seller: role=seller. CAMPAIGN worker: role=buyer (slot worker is buyerWallet).
  FILE seller: signed upload then POST listing (ACTIVE). TOKEN seller: POST DRAFT then createAndLock + POST /lock.
  PAID SERVICE/CAMPAIGN = needs on-chain deliver. Watch does NOT invent a URI.
  deliver() on listing.escrowContract. POST { uri, sellerWallet, txHash } — no personal_sign.
  Legacy BUYER_JOB: accept(orderId, worker) when seller==0. New jobs use offer, not accept.

  Install: git clone https://github.com/gigsescrow/scripts.git && cd scripts && npm install

Commands
  npm run gig:init && npm run gig:watch
  node gigsescrow-gig.mjs deliver --order <uuid> --uri <string>
  node gigsescrow-gig.mjs deliver --order <uuid> --file <path>
  node gigsescrow-gig.mjs decrypt --order <uuid> --out <path>
  node gigsescrow-gig.mjs verify-delivery --order <uuid> --file <decrypted path> [--post]
  node gigsescrow-gig.mjs offer --listing <id> --price <6dec> --days <1-60> --message "<text>"
  node gigsescrow-gig.mjs accept --order <uuid>
  node gigsescrow-gig.mjs accept --listing <id>
  node gigsescrow-gig.mjs apply --listing <id>
  node gigsescrow-gig.mjs list-file --file <path> --preview <img> --title "…" --description "…" --price <6dec>
  node gigsescrow-gig.mjs list-token --token 0x… --amount <int> --price <6dec> --title "…" --description "…" [--lock]
  node gigsescrow-gig.mjs lock-lot --listing <id>
  node gigsescrow-gig.mjs cancel-lot --listing <id>
  node gigsescrow-gig.mjs file-refund --order <uuid>

Env
  # MetaMask/Rabby show 64 hex WITHOUT 0x. Put 0x in front of those 64 characters.
  # Same wallet you connected on the site as the gig worker.
  export GIGSESCROW_PRIVATE_KEY=0xPASTE_64_HEX_FROM_METAMASK
  export GIGSESCROW_API=${DEFAULT_API}
  # Arc + Robinhood both: omit GIGSESCROW_CHAIN_ID
  # One chain only: export GIGSESCROW_CHAIN_ID=5042002
  # Optional auto-deliver (watch): export GIGSESCROW_DELIVER_URI=ipfs://…   default OFF
`);
}


async function init() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const current = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
  const next = {
    apiBase: process.env.GIGSESCROW_API || current.apiBase || DEFAULT_API,
    chainIds: loadConfig().chainIds,
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  console.log("Wrote", CONFIG_PATH);
  printRubric();
  console.log(
    "Then in THIS Terminal: export GIGSESCROW_PRIVATE_KEY=0x + the 64 hex MetaMask shows (it has no 0x). Then npm run gig:watch"
  );
}



async function tickList(cfg, account, chainId, autoUri, role, kind) {
  const data = await api(
    cfg.apiBase,
    `/api/orders?wallet=${account.address}&role=${role}&bucket=in_process&kind=${kind}&chainId=${chainId}`
  );
  const orders = Array.isArray(data.orders) ? data.orders : [];
  if (!orders.length) {
    console.log(chainId, kind, role, "idle");
    return;
  }
  for (const order of orders) {
    if (order.status === "PAID") {
      console.log(chainId, kind, "needs deliver", order.id, order.listing?.title || "");
      if (autoUri) await deliverOrder(cfg, account, order.id, autoUri);
    } else if (order.status === "DELIVERED") {
      console.log(chainId, kind, "info DELIVERED", order.id, order.listing?.title || "");
    } else {
      console.log(chainId, kind, order.status, order.id, order.listing?.title || "");
    }
  }
}

async function tickChain(cfg, account, chainId, autoUri) {
  await tickList(cfg, account, chainId, autoUri, "seller", "SERVICE");
  await tickList(cfg, account, chainId, autoUri, "buyer", "CAMPAIGN");
}

async function acceptOrder(cfg, account, order) {
  if (order.origin !== "BUYER_JOB") throw new Error(`${order.id} is not BUYER_JOB`);
  if (order.status !== "PAID") throw new Error(`${order.id} status=${order.status} — accept after lock`);
  const seller = String(order.sellerWallet || "").toLowerCase();
  if (seller && seller !== "0x0000000000000000000000000000000000000000") {
    throw new Error(`${order.id} seller already set — use offer path, not accept`);
  }
  if (String(order.buyerWallet || "").toLowerCase() === account.address.toLowerCase()) {
    throw new Error("cannot accept own job");
  }
  const escrow = requireEscrow(order.listing, order.id);
  const chainId = Number(order.listing?.chainId);
  const { publicClient, walletClient } = clientsFor(chainId, account);
  const orderBytes32 = getOrderBytes32(order);
  console.log(chainId, "accept", escrow, order.id, account.address);
  const txHash = await walletClient.writeContract({
    address: escrow,
    abi: acceptAbi,
    functionName: "accept",
    args: [orderBytes32, account.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`${order.id} accept failed ${txHash}`);
  await api(cfg.apiBase, `/api/orders/${encodeURIComponent(order.id)}/accept`, {
    method: "POST",
    body: JSON.stringify({ sellerWallet: account.address, txHash }),
  });
  console.log(chainId, "ACCEPTED", order.id, txHash);
}

async function acceptCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const orderId = flagValue("--order").trim();
  const listingId = flagValue("--listing").trim();
  let order;
  if (orderId) {
    order = (await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}`)).order;
  } else if (listingId) {
    const body = await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listingId)}`);
    order = body.jobOrder;
    if (order && !order.listing) order.listing = body.listing;
  } else {
    throw new Error("accept --order <uuid> or --listing <id> required");
  }
  if (!order?.id) throw new Error("no locked job order to accept");
  await acceptOrder(cfg, account, order);
}

async function applyCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const listingId = flagValue("--listing").trim();
  if (!listingId) throw new Error("apply --listing <id> required");
  await applyToListing(cfg, account, listingId);
}


async function watch() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const autoUri = loadAutoDeliverUri();
  console.log("Gig worker watch", account.address, "chains", cfg.chainIds.join(","));
  printRubric();
  if (autoUri) {
    console.log("auto-deliver ON from --uri-file or GIGSESCROW_DELIVER_URI. Default is OFF.");
  } else {
    console.log("auto-deliver OFF. Detect+log PAID only. Pass --uri-file or GIGSESCROW_DELIVER_URI to auto-deliver. Do not invent URIs.");
  }

  while (true) {
    for (const chainId of cfg.chainIds) {
      try {
        await tickChain(cfg, account, chainId, autoUri);
      } catch (err) {
        console.error("watch", chainId, err.message || err);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function deliverCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const orderId = flagValue("--order").trim();
  const filePath = flagValue("--file").trim();
  const uri = (flagValue("--uri") || (filePath ? "" : loadAutoDeliverUri())).trim();
  if (!orderId) throw new Error("deliver --order <uuid> required");
  if (filePath) {
    await deliverEncrypted(cfg, account, orderId, filePath);
    return;
  }
  if (!uri) throw new Error("deliver --uri <string> or --file <path> required");
  await deliverOrder(cfg, account, orderId, uri);
}


async function decryptCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const orderId = flagValue("--order").trim();
  const outPath = flagValue("--out").trim();
  if (!orderId || !outPath) throw new Error("decrypt --order <uuid> --out <path> required");
  await decryptOrder(cfg, account, orderId, outPath);
}

async function verifyDeliveryCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const orderId = flagValue("--order").trim();
  const filePath = flagValue("--file").trim();
  if (!orderId || !filePath) throw new Error("verify-delivery --order <uuid> --file <path> required");
  await verifyDelivery(cfg, account, orderId, filePath, { post: hasFlag("--post"), notes: flagValue("--notes") });
}

async function offerCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const listingId = flagValue("--listing").trim();
  const priceUsdc = flagValue("--price").trim();
  const days = flagValue("--days").trim();
  const message = flagValue("--message").trim();
  if (!listingId) throw new Error("offer --listing <id> required");
  if (!/^[0-9]+$/.test(priceUsdc) || priceUsdc === "0") {
    throw new Error("offer --price <6-decimal integer string> required (1000000 = 1.000000)");
  }
  const dayN = Number(days);
  if (!Number.isFinite(dayN) || dayN < 1 || dayN > 60) {
    throw new Error("offer --days <1-60> required");
  }
  if (!message || message.length > 400) {
    throw new Error("offer --message required, max 400 chars");
  }
  const listing = (await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listingId)}`)).listing;
  if (!listing?.id) throw new Error(`listing not found: ${listingId}`);
  if (listing.origin !== "BUYER_JOB") throw new Error(`${listingId} is not BUYER_JOB`);
  const data = await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listingId)}/offers`, {
    method: "POST",
    body: JSON.stringify({
      wallet: account.address,
      priceUsdc,
      deliveryDays: dayN,
      message,
    }),
  });
  console.log("offer", data.offer?.id || "", listing.title || listingId, priceUsdc, `${dayN}d`);
}

async function ensureAllowance(publicClient, walletClient, token, owner, spender, amount) {
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

async function uploadSession(cfg, account) {
  const challenge = await api(cfg.apiBase, `/api/upload/challenge?wallet=${account.address}`);
  if (!challenge.message) throw new Error("upload challenge missing message");
  const signature = await account.signMessage({ message: challenge.message });
  const session = await api(cfg.apiBase, "/api/upload/session", {
    method: "POST",
    body: JSON.stringify({ wallet: account.address, message: challenge.message, signature }),
  });
  if (!session.token) throw new Error("upload session missing token");
  return session.token;
}

async function uploadWithToken(cfg, token, filePath, kind) {
  if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
  const mime = mimeFromPath(filePath);
  if (kind === "preview" && !mime) {
    throw new Error(`preview must be jpg/png/gif/webp: ${filePath}`);
  }
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], mime ? { type: mime } : {}), basename(filePath));
  if (kind) form.append("kind", kind);
  const res = await fetch(`${cfg.apiBase}/api/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} /api/upload`);
  if (!data.fileKey) throw new Error("upload missing fileKey");
  return data.fileKey;
}

function listingMeta() {
  const title = flagValue("--title").trim();
  const description = flagValue("--description").trim();
  const priceUsdc = flagValue("--price").trim();
  const chainRaw = flagValue("--chain-id").trim();
  if (!title) throw new Error("--title required");
  if (!description) throw new Error("--description required (max 1000)");
  if (description.length > 1000) throw new Error("--description max 1000 chars");
  const chainId = chainRaw ? Number(chainRaw) : loadConfig().chainIds[0];
  if (!Number.isFinite(chainId)) throw new Error("--chain-id required or set GIGSESCROW_CHAIN_ID");
  return { title, description, priceUsdc, chainId };
}

async function listFileCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const filePath = flagValue("--file").trim();
  if (!filePath) throw new Error("list-file --file <path> required");
  const { title, description, priceUsdc, chainId } = listingMeta();
  if (!/^[0-9]+$/.test(priceUsdc) || priceUsdc === "0") {
    throw new Error("list-file --price <6-decimal integer> required");
  }
  const previews = flagValues("--preview");
  if (previews.length < 1 || previews.length > 4) {
    throw new Error("list-file --preview <image> required (1–4 jpg/png/gif/webp)");
  }
  const token = await uploadSession(cfg, account);
  const plain = new Uint8Array(readFileSync(filePath));
  if (plain.length > 32 * 1024 * 1024) throw new Error("plaintext larger than 32 MB");
  const { dek, blob } = await encryptPlaintext(plain);
  const sellerPub = publicKeyFromPrivate(cfg.privateKey);
  const listingFileRef = {
    schemaVersion: 1,
    cipher: "aes-256-gcm",
    storage: "disk",
    locator: "",
    contentHash: contentHashOf(plain),
    cipherHash: cipherHashOf(blob),
    mime: mimeFromPath(filePath) || "application/octet-stream",
    size: blob.length,
    keyWrap: { scheme: "eth-ecies", seller: await wrapDek(dek, sellerPub) },
  };
  const form = new FormData();
  form.set("mime", listingFileRef.mime);
  form.set("contentHash", listingFileRef.contentHash);
  form.set("ciphertext", new Blob([blob]), "product.bin");
  const upRes = await fetch(`${cfg.apiBase}/api/listings/file-upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const up = await upRes.json().catch(() => ({}));
  if (!upRes.ok) throw new Error(up.error || `file-upload ${upRes.status}`);
  listingFileRef.storage = up.storage;
  listingFileRef.locator = up.locator;
  listingFileRef.cipherHash = up.cipherHash;
  listingFileRef.size = up.size;
  const previewKeys = [];
  for (const previewPath of previews) {
    previewKeys.push(await uploadWithToken(cfg, token, previewPath, "preview"));
  }
  const samplePath = flagValue("--sample").trim();
  const sampleStorageKey = samplePath ? await uploadWithToken(cfg, token, samplePath, "") : null;
  const data = await api(cfg.apiBase, "/api/listings", {
    method: "POST",
    body: JSON.stringify({
      title,
      description,
      priceUsdc,
      kind: "FILE",
      origin: "SELLER_FILE",
      payoutAddress: account.address,
      listingFileRef,
      previewKeys,
      sampleStorageKey,
      chainId,
    }),
  });
  console.log("FILE listed", data.listing?.id, data.listing?.status, data.listing?.encryptedFile ? "encrypted" : "", title);
}

async function arbWrapCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const orderId = flagValue("--order").trim();
  if (!orderId) throw new Error("arb-wrap --order <uuid> required");
  const pubs = await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}/delivery-arb-pubs`);
  if (!pubs.pubkey) throw new Error("reviewer public key unavailable");
  const packed = await api(
    cfg.apiBase,
    `/api/orders/${encodeURIComponent(orderId)}/delivery?wallet=${account.address}`
  );
  if (!packed.wrap) throw new Error("no key wrap for this wallet");
  const dek = await unwrapDek(packed.wrap, cfg.privateKey);
  const wrap = await wrapDek(dek, pubs.pubkey);
  await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}/delivery-arb-wrap`, {
    method: "POST",
    body: JSON.stringify({ wallet: account.address, wrap }),
  });
  console.log("arbitrator key granted", orderId, pubs.kind || "", pubs.wallet);
}

async function grantFileCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const orderId = flagValue("--order").trim();
  if (!orderId) throw new Error("grant-file --order <uuid> required");
  const pubs = await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}/listing-file-pubs`);
  if (!pubs.buyer) throw new Error("buyer public key unavailable");
  const packed = await api(
    cfg.apiBase,
    `/api/orders/${encodeURIComponent(orderId)}/listing-file?wallet=${account.address}`
  );
  const dek = await unwrapDek(packed.wrap, cfg.privateKey);
  const buyerWrap = await wrapDek(dek, pubs.buyer);
  await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}/listing-file-wrap`, {
    method: "POST",
    body: JSON.stringify({ wallet: account.address, buyerWrap }),
  });
  console.log("buyer key granted", orderId);
}

async function decryptListingCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const orderId = flagValue("--order").trim();
  const outPath = flagValue("--out").trim();
  if (!orderId || !outPath) throw new Error("decrypt-listing --order <uuid> --out <path> required");
  const data = await api(
    cfg.apiBase,
    `/api/orders/${encodeURIComponent(orderId)}/listing-file?wallet=${account.address}`
  );
  const dek = await unwrapDek(data.wrap, cfg.privateKey);
  const plain = await decryptCiphertext(fromB64(data.ciphertext), dek);
  if (contentHashOf(plain) !== data.contentHash) throw new Error("content hash mismatch");
  writeFileSync(outPath, plain);
  console.log("decrypted", outPath, plain.length);
}

async function lockLot(cfg, account, listing) {
  if (listing.kind !== "TOKEN" || listing.origin !== "SELLER_TOKEN") {
    throw new Error(`${listing.id} is not SELLER_TOKEN`);
  }
  const escrow = requireEscrow(listing, listing.id);
  const token = String(listing.assetToken || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(token)) throw new Error(`${listing.id} missing assetToken`);
  const amount = BigInt(listing.assetAmount);
  const price = BigInt(listing.priceUsdc);
  const chainId = Number(listing.chainId);
  const { publicClient, walletClient } = clientsFor(chainId, account);
  await ensureAllowance(publicClient, walletClient, token, account.address, escrow, amount);
  const listingBytes32 = uuidToBytes32(listing.id);
  console.log(chainId, "lot lock", escrow, listing.id);
  const txHash = await walletClient.writeContract({
    address: escrow,
    abi: lotAbi,
    functionName: "createAndLock",
    args: [listingBytes32, token, amount, price],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`${listing.id} lot lock failed ${txHash}`);
  await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listing.id)}/lock`, {
    method: "POST",
    body: JSON.stringify({ wallet: account.address, txHash }),
  });
  console.log(chainId, "LOT LOCKED", listing.id, txHash);
}

async function listTokenCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const token = flagValue("--token").trim();
  const amount = flagValue("--amount").trim();
  const { title, description, priceUsdc, chainId } = listingMeta();
  if (!/^0x[a-fA-F0-9]{40}$/.test(token)) throw new Error("list-token --token 0x… required");
  if (!/^[0-9]+$/.test(amount) || amount === "0") throw new Error("list-token --amount <integer> required");
  if (!/^[0-9]+$/.test(priceUsdc) || priceUsdc === "0") throw new Error("list-token --price <6-decimal integer> required");
  const data = await api(cfg.apiBase, "/api/listings", {
    method: "POST",
    body: JSON.stringify({
      title,
      description,
      priceUsdc,
      kind: "TOKEN",
      origin: "SELLER_TOKEN",
      payoutAddress: account.address,
      assetToken: token,
      assetAmount: amount,
      chainId,
    }),
  });
  const listing = data.listing;
  console.log("TOKEN draft", listing?.id, listing?.status, title);
  if (hasFlag("--lock") && listing?.id) await lockLot(cfg, account, listing);
}

async function lockLotCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const listingId = flagValue("--listing").trim();
  if (!listingId) throw new Error("lock-lot --listing <id> required");
  const listing = (await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listingId)}`)).listing;
  if (!listing?.id) throw new Error(`listing not found: ${listingId}`);
  await lockLot(cfg, account, listing);
}

async function cancelLotCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const listingId = flagValue("--listing").trim();
  if (!listingId) throw new Error("cancel-lot --listing <id> required");
  const listing = (await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listingId)}`)).listing;
  if (!listing?.id) throw new Error(`listing not found: ${listingId}`);
  if (listing.kind !== "TOKEN") throw new Error(`${listingId} is not TOKEN`);
  if (String(listing.payoutAddress || "").toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("not listing owner");
  }
  const escrow = requireEscrow(listing, listing.id);
  const chainId = Number(listing.chainId);
  const { publicClient, walletClient } = clientsFor(chainId, account);
  const listingBytes32 = uuidToBytes32(listing.id);
  console.log(chainId, "lot cancel", escrow, listing.id);
  const txHash = await walletClient.writeContract({
    address: escrow,
    abi: lotAbi,
    functionName: "cancel",
    args: [listingBytes32],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`${listing.id} cancel failed ${txHash}`);
  await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listing.id)}/unlock`, {
    method: "POST",
    body: JSON.stringify({ wallet: account.address, txHash }),
  });
  console.log(chainId, "LOT CANCELLED", listing.id, txHash);
}

async function fileRefundCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const orderId = flagValue("--order").trim();
  if (!orderId) throw new Error("file-refund --order <uuid> required");
  const order = (await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}`)).order;
  if (!order?.id) throw new Error(`order not found: ${orderId}`);
  if (order.kind !== "FILE") throw new Error(`${order.id} is not FILE`);
  if (String(order.sellerWallet || "").toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("only FILE seller refunds");
  }
  if (order.status !== "PAID") throw new Error(`${order.id} status=${order.status}`);
  if (!order.disputeOpenedAt) throw new Error(`${order.id} needs an open file dispute first (site)`);
  const chainId = Number(order.listing?.chainId);
  const usdc = CHAINS[chainId]?.usdc;
  if (!usdc) throw new Error(`${chainId} missing USDC/USDG`);
  const amount = BigInt(order.priceUsdc) - BigInt(order.feeUsdc || 0);
  const { publicClient, walletClient } = clientsFor(chainId, account);
  console.log(chainId, "file refund transfer", order.buyerWallet, amount.toString());
  const txHash = await walletClient.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "transfer",
    args: [order.buyerWallet, amount],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`${order.id} transfer failed ${txHash}`);
  await api(cfg.apiBase, `/api/orders/${encodeURIComponent(order.id)}/refund`, {
    method: "POST",
    body: JSON.stringify({ callerWallet: account.address, txHashRefund: txHash }),
  });
  console.log(chainId, "FILE REFUNDED", order.id, txHash);
}

const cmd = process.argv[2] || "help";
if (cmd === "init") {
  init().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "watch") {
  watch().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "deliver") {
  deliverCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "decrypt") {
  decryptCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "verify-delivery") {
  verifyDeliveryCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "offer") {
  offerCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "accept") {
  acceptCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "apply") {
  applyCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "arb-wrap") {
  arbWrapCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "grant-file") {
  grantFileCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "decrypt-listing") {
  decryptListingCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "list-file") {
  listFileCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "list-token") {
  listTokenCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "lock-lot") {
  lockLotCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "cancel-lot") {
  cancelLotCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (cmd === "file-refund") {
  fileRefundCmd().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else {
  printRubric();
}
