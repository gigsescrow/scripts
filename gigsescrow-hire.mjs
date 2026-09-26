#!/usr/bin/env node
/**
 * Gig/job hirer CLI. Signs approve + createAndLock + release only.
 * No LLM auto-work. No browser automation. Never hardcode escrow.
 *
 *   node gigsescrow-hire.mjs init
 *   node gigsescrow-hire.mjs watch
 *   node gigsescrow-hire.mjs book --listing <id>
 *   node gigsescrow-hire.mjs hire --listing <id> --offer <id>
 *   node gigsescrow-hire.mjs lock --order <uuid>
 *   node gigsescrow-hire.mjs release --order <uuid>
 *
 * Env: GIGSESCROW_PRIVATE_KEY, GIGSESCROW_API
 * Optional: GIGSESCROW_CHAIN_ID or GIGSESCROW_CHAIN_IDS=5042002,46630
 * Auto-release (default OFF): --auto-release or GIGSESCROW_AUTO_RELEASE=1
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CHAINS,
  api,
  bookAndLock,
  clientsFor,
  ensureAllowance,
  getOrderBytes32,
  loadWalletConfig,
  lockOrder,
  requireEscrow,
  requireKey,
  uuidToBytes32,
} from "./lib/gigsescrow-core.mjs";

const CONFIG_DIR = join(homedir(), ".gigsescrow-hire");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DEFAULT_API = process.env.GIGSESCROW_API || "https://gigsescrow.com";
const DEFAULT_CHAINS = [5042002, 46630];
const POLL_MS = 15_000;
const ZERO = "0x0000000000000000000000000000000000000000";


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
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "bytes32" }],
    outputs: [],
  },
];

const filePayAbi = [
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "seller", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
];

const tokenBuyAbi = [
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [{ name: "listingId", type: "bytes32" }],
    outputs: [],
  },
];

const campaignReleaseAbi = [
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refundSlot",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "bytes32" }],
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

function loadConfig() {
  return loadWalletConfig(CONFIG_PATH);
}


function autoReleaseOn() {
  if (hasFlag("--auto-release")) return true;
  const env = String(process.env.GIGSESCROW_AUTO_RELEASE || "").trim();
  return env === "1" || env.toLowerCase() === "true";
}

function printRubric() {
  console.log(`
Customer hirer/buyer CLI
  SERVICE buyer: book / hire / lock / release / refund (PAID only).
  FILE: pay --listing (approve + FileFeeRouter.pay on order.payTo) then download --order.
  TOKEN: buy --listing (approve + AssetEscrow.buy on listing.escrowContract).
  Campaign worker uses gig.mjs apply. Opening a campaign is the allowlisted wallet only — not this CLI.
  Never omit role=. Never hardcode escrow — listing.escrowContract or order.payTo from API.

  Install: git clone https://github.com/gigsescrow/scripts.git && cd scripts && npm install

Commands
  npm run hire:init && npm run hire:watch
  node gigsescrow-hire.mjs book --listing <id>
  node gigsescrow-hire.mjs hire --listing <id> --offer <id>
  node gigsescrow-hire.mjs lock --order <uuid>
  node gigsescrow-hire.mjs release --order <uuid>
  node gigsescrow-hire.mjs refund --order <uuid>
  node gigsescrow-hire.mjs pay --listing <id>
  node gigsescrow-hire.mjs buy --listing <id>
  node gigsescrow-hire.mjs download --order <uuid>

Env
  export GIGSESCROW_PRIVATE_KEY=0xPASTE_64_HEX_FROM_METAMASK
  export GIGSESCROW_API=${DEFAULT_API}
  # Auto-release DELIVERED orders: --auto-release or GIGSESCROW_AUTO_RELEASE=1   default OFF
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
}


async function releaseOrder(cfg, account, orderId) {
  const data = await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}`);
  const order = data.order;
  if (!order?.id) throw new Error(`order not found: ${orderId}`);
  const isCampaign = order.kind === "CAMPAIGN";
  if (order.kind !== "SERVICE" && !isCampaign) {
    throw new Error(`${order.id} kind=${order.kind} — release SERVICE (hirer) or CAMPAIGN (creator)`);
  }
  if (order.status !== "DELIVERED") {
    throw new Error(`${order.id} status=${order.status} — release after DELIVERED (do not invent release)`);
  }
  if (isCampaign) {
    if (String(order.sellerWallet || "").toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(`${order.id} sellerWallet (creator) is not this key`);
    }
  } else if (String(order.buyerWallet || "").toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`${order.id} buyerWallet is not this key`);
  }
  const escrow = requireEscrow(order.listing, order.id);
  const chainId = Number(order.listing?.chainId);
  const { publicClient, walletClient } = clientsFor(chainId, account);
  const orderBytes32 = getOrderBytes32(order);
  console.log(chainId, "release", escrow, order.id);
  const txHash = await walletClient.writeContract({
    address: escrow,
    abi: isCampaign ? campaignReleaseAbi : escrowAbi,
    functionName: "release",
    args: [orderBytes32],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`${order.id} release failed ${txHash}`);
  await api(cfg.apiBase, `/api/orders/${encodeURIComponent(order.id)}/release`, {
    method: "POST",
    body: JSON.stringify(
      isCampaign
        ? { callerWallet: account.address, txHashRelease: txHash }
        : { buyerWallet: account.address, txHashRelease: txHash }
    ),
  });
  console.log(chainId, "RELEASED", order.id, txHash);
  return txHash;
}

async function refundOrder(cfg, account, orderId) {
  const data = await api(cfg.apiBase, `/api/orders/${encodeURIComponent(orderId)}`);
  const order = data.order;
  if (!order?.id) throw new Error(`order not found: ${orderId}`);
  if (order.status !== "PAID") {
    throw new Error(`${order.id} status=${order.status} — CLI refund only while Fund locked (PAID). DELIVERED uses the site/dispute path.`);
  }
  const caller = account.address.toLowerCase();
  if (caller !== String(order.buyerWallet || "").toLowerCase() && caller !== String(order.sellerWallet || "").toLowerCase()) {
    throw new Error(`${order.id} not a party`);
  }
  const isCampaign = order.kind === "CAMPAIGN";
  if (order.kind !== "SERVICE" && !isCampaign) {
    throw new Error(`${order.id} kind=${order.kind} — CLI refund is SERVICE/CAMPAIGN escrow only`);
  }
  const escrow = requireEscrow(order.listing, order.id);
  const chainId = Number(order.listing?.chainId);
  const { publicClient, walletClient } = clientsFor(chainId, account);
  const orderBytes32 = getOrderBytes32(order);
  console.log(chainId, isCampaign ? "refundSlot" : "refund", escrow, order.id);
  const txHash = await walletClient.writeContract({
    address: escrow,
    abi: isCampaign ? campaignReleaseAbi : escrowAbi,
    functionName: isCampaign ? "refundSlot" : "refund",
    args: [orderBytes32],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`${order.id} refund failed ${txHash}`);
  await api(cfg.apiBase, `/api/orders/${encodeURIComponent(order.id)}/refund`, {
    method: "POST",
    body: JSON.stringify({ callerWallet: account.address, txHashRefund: txHash }),
  });
  console.log(chainId, "REFUNDED", order.id, txHash);
}

async function payFileCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const listingId = flagValue("--listing").trim();
  if (!listingId) throw new Error("pay --listing <id> required");
  const listing = (await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listingId)}`)).listing;
  if (!listing?.id) throw new Error(`listing not found: ${listingId}`);
  if (listing.kind !== "FILE") throw new Error(`${listingId} is not FILE`);
  const created = await api(cfg.apiBase, "/api/orders", {
    method: "POST",
    body: JSON.stringify({ listingId, buyerWallet: account.address }),
  });
  const order = created.order;
  const router = String(order.payTo || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(router)) {
    throw new Error(`${order.id} missing order.payTo (FileFeeRouter) from API — never hardcode`);
  }
  const chainId = Number(listing.chainId);
  const token = CHAINS[chainId]?.usdc;
  if (!token) throw new Error(`${chainId} missing USDC/USDG address`);
  const amount = BigInt(order.priceUsdc);
  const { publicClient, walletClient } = clientsFor(chainId, account);
  await ensureAllowance(publicClient, walletClient, token, account.address, router, amount);
  const orderBytes32 = getOrderBytes32(order);
  console.log(chainId, "file pay", router, order.id);
  const txHash = await walletClient.writeContract({
    address: router,
    abi: filePayAbi,
    functionName: "pay",
    args: [orderBytes32, order.sellerWallet, amount],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`${order.id} pay failed ${txHash}`);
  await api(cfg.apiBase, `/api/orders/${encodeURIComponent(order.id)}/attach-tx`, {
    method: "POST",
    body: JSON.stringify({ txHash }),
  });
  console.log(chainId, "FILE PAID", order.id, txHash);
  await downloadOrder(cfg, account, order.id);
}

async function buyTokenCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const listingId = flagValue("--listing").trim();
  if (!listingId) throw new Error("buy --listing <id> required");
  const listing = (await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listingId)}`)).listing;
  if (!listing?.id) throw new Error(`listing not found: ${listingId}`);
  if (listing.kind !== "TOKEN") throw new Error(`${listingId} is not TOKEN`);
  const escrow = requireEscrow(listing, listingId);
  const created = await api(cfg.apiBase, "/api/orders", {
    method: "POST",
    body: JSON.stringify({ listingId, buyerWallet: account.address }),
  });
  const order = created.order;
  const chainId = Number(listing.chainId);
  const token = CHAINS[chainId]?.usdc;
  if (!token) throw new Error(`${chainId} missing USDC/USDG address`);
  const amount = BigInt(order.priceUsdc);
  const { publicClient, walletClient } = clientsFor(chainId, account);
  await ensureAllowance(publicClient, walletClient, token, account.address, escrow, amount);
  const listingBytes32 = uuidToBytes32(listing.id);
  console.log(chainId, "token buy", escrow, listing.id);
  const txHash = await walletClient.writeContract({
    address: escrow,
    abi: tokenBuyAbi,
    functionName: "buy",
    args: [listingBytes32],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`${order.id} buy failed ${txHash}`);
  await api(cfg.apiBase, `/api/orders/${encodeURIComponent(order.id)}/attach-tx`, {
    method: "POST",
    body: JSON.stringify({ txHash }),
  });
  console.log(chainId, "TOKEN BOUGHT", order.id, txHash);
}

async function downloadOrder(cfg, account, orderId) {
  const data = await api(
    cfg.apiBase,
    `/api/orders/${encodeURIComponent(orderId)}/download?wallet=${account.address}`
  );
  if (data.encrypted) {
    console.log("encrypted file; seller must grant-file, then decrypt-listing --order", orderId);
    return;
  }
  console.log("downloadUrl", data.downloadUrl ? `${cfg.apiBase}${data.downloadUrl}` : data);
  if (data.expiresAt) console.log("expiresAt", data.expiresAt);
}

async function downloadCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const orderId = flagValue("--order").trim();
  if (!orderId) throw new Error("download --order <uuid> required");
  await downloadOrder(cfg, account, orderId);
}

async function bookCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const listingId = flagValue("--listing").trim();
  if (!listingId) throw new Error("book --listing <id> required");
  const listing = (await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listingId)}`)).listing;
  if (!listing?.id) throw new Error(`listing not found: ${listingId}`);
  if (listing.kind !== "SERVICE" || listing.origin !== "SELLER_GIG") {
    throw new Error(`${listingId} is not a SELLER_GIG service — use hire for BUYER_JOB`);
  }
  await bookAndLock(cfg, account, listingId);
}

async function hireCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const listingId = flagValue("--listing").trim();
  const offerId = flagValue("--offer").trim();
  if (!listingId) throw new Error("hire --listing <id> required");
  if (!offerId) throw new Error("hire --offer <id> required");
  const listing = (await api(cfg.apiBase, `/api/listings/${encodeURIComponent(listingId)}`)).listing;
  if (!listing?.id) throw new Error(`listing not found: ${listingId}`);
  if (listing.origin !== "BUYER_JOB") throw new Error(`${listingId} is not BUYER_JOB — use book for gigs`);
  const hired = await api(
    cfg.apiBase,
    `/api/listings/${encodeURIComponent(listingId)}/offers/${encodeURIComponent(offerId)}/hire`,
    { method: "POST", body: JSON.stringify({ wallet: account.address }) }
  );
  const order = hired.order;
  const timeout = hired.order?.lockTimeoutSec ?? listing.deliveryTimeoutSec;
  console.log("hired", order.id, offerId, order.priceUsdc, `${timeout}s`);
  await lockOrder(cfg, account, order.id, timeout);
}

async function lockCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const orderId = flagValue("--order").trim();
  if (!orderId) throw new Error("lock --order <uuid> required");
  const timeoutRaw = flagValue("--timeout-sec").trim();
  const timeout = timeoutRaw ? Number(timeoutRaw) : undefined;
  if (timeoutRaw && !Number.isFinite(timeout)) throw new Error("--timeout-sec must be a number");
  await lockOrder(cfg, account, orderId, timeout);
}

async function releaseCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const orderId = flagValue("--order").trim();
  if (!orderId) throw new Error("release --order <uuid> required");
  await releaseOrder(cfg, account, orderId);
}

async function refundCmd() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const orderId = flagValue("--order").trim();
  if (!orderId) throw new Error("refund --order <uuid> required");
  await refundOrder(cfg, account, orderId);
}

async function tickList(cfg, account, chainId, doAutoRelease, role, kind) {
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
    if (order.status === "AWAITING_PAYMENT") {
      console.log(chainId, kind, "needs lock/pay", order.id, order.listing?.title || "");
    } else if (order.status === "PAID") {
      console.log(chainId, kind, role === "buyer" ? "waiting worker" : "waiting deliver/release", order.id, order.listing?.title || "");
    } else if (order.status === "DELIVERED") {
      console.log(chainId, kind, "needs release", order.id, order.listing?.title || "");
      if (doAutoRelease) await releaseOrder(cfg, account, order.id);
    } else {
      console.log(chainId, kind, order.status, order.id, order.listing?.title || "");
    }
  }
}

async function tickChain(cfg, account, chainId, doAutoRelease) {
  await tickList(cfg, account, chainId, doAutoRelease, "buyer", "SERVICE");
  // Campaign creator watch is the allowlisted wallet only. Hidden from this kit.
}

async function watch() {
  const cfg = loadConfig();
  const account = requireKey(cfg);
  const doAutoRelease = autoReleaseOn();
  console.log("Hirer watch", account.address, "chains", cfg.chainIds.join(","));
  printRubric();
  if (doAutoRelease) {
    console.log("auto-release ON. Default is OFF. This spends locked USDC to the worker.");
  } else {
    console.log("auto-release OFF. Detect+log DELIVERED only. Pass --auto-release to release.");
  }
  while (true) {
    for (const chainId of cfg.chainIds) {
      try {
        await tickChain(cfg, account, chainId, doAutoRelease);
      } catch (err) {
        console.error("watch", chainId, err.message || err);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const cmd = process.argv[2] || "help";
const run = {
  init,
  watch,
  book: bookCmd,
  hire: hireCmd,
  lock: lockCmd,
  release: releaseCmd,
  refund: refundCmd,
  pay: payFileCmd,
  buy: buyTokenCmd,
  download: downloadCmd,
}[cmd];
if (run) {
  run().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else {
  printRubric();
}
