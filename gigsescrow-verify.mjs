#!/usr/bin/env node
/**
 * FileInspect agent CLI. Signs accept/submit only.
 * The server keeps the seller file and calls the agent's OpenRouter key.
 *
 *   node gigsescrow-verify.mjs init
 *   node gigsescrow-verify.mjs watch
 *
 * Env: GIGSESCROW_PRIVATE_KEY, GIGSESCROW_API
 * Optional: GIGSESCROW_CHAIN_ID (one chain) or GIGSESCROW_CHAIN_IDS=5042002,46630
 */
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".gigsescrow-verify");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DEFAULT_API = process.env.GIGSESCROW_API || "https://gigsescrow.com";
const DEFAULT_CHAINS = [5042002, 46630];
const POLL_MS = 15_000;
const ZERO = "0x0000000000000000000000000000000000000000";

const CHAINS = {
  5042002: {
    name: "arc-testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrl: process.env.GIGSESCROW_ARC_RPC || "https://rpc.testnet.arc.io",
  },
  46630: {
    name: "robinhood-testnet",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrl: process.env.GIGSESCROW_RPC || "https://rpc.testnet.chain.robinhood.com",
  },
};

const fileInspectAbi = [
  {
    type: "function",
    name: "accept",
    stateMutability: "nonpayable",
    inputs: [{ name: "requestId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "bytes32" },
      { name: "passed", type: "bool" },
      { name: "reportHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "agentActive",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "agentCooldownUntil",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint64" }],
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

function loadConfig() {
  const file = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
  const privateKey = normalizePrivateKey(process.env.GIGSESCROW_PRIVATE_KEY || file.privateKey || "");
  const one = process.env.GIGSESCROW_CHAIN_ID || file.chainId;
  const chainIds = one
    ? parseChainIds(one, DEFAULT_CHAINS)
    : parseChainIds(process.env.GIGSESCROW_CHAIN_IDS || file.chainIds, DEFAULT_CHAINS);
  return {
    apiBase: (process.env.GIGSESCROW_API || file.apiBase || DEFAULT_API).replace(/\/$/, ""),
    chainIds,
    privateKey,
    inspect: process.env.GIGSESCROW_INSPECT || file.inspect || "",
  };
}

function printRubric() {
  console.log(`
FileInspect agent (required CLI)
  Register a wallet + OpenRouter key on the site. This watch loop is mandatory.
  The seller file stays on the server. Your LLM reads it there.
  HASH is checked on the stored bytes. The model compares contents to the listing.

  Clone the public CLI only: https://github.com/gigsescrow/scripts
  Do not clone the marketplace source.

Commands
  npm run verify:init
  npm run verify:watch

Env
  # MetaMask/Rabby show 64 hex WITHOUT 0x. Put 0x in front of those 64 characters.
  # Same wallet you connected on the site. Not the OpenRouter sk-or-… key.
  # export in THIS Terminal, then npm run verify:watch
  export GIGSESCROW_PRIVATE_KEY=0xPASTE_64_HEX_FROM_METAMASK
  export GIGSESCROW_API=${DEFAULT_API}
  # Arc (Circle USDC faucet): export GIGSESCROW_CHAIN_ID=5042002
  # Robinhood: export GIGSESCROW_CHAIN_ID=46630
  # Or watch both (this repo): omit GIGSESCROW_CHAIN_ID

Pay
  1% of the file listing. 0.5% to this wallet on submit. 0.5% protocol on pass.
`);
}

async function api(base, path, init) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${path}`);
  return data;
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
    "Required: OpenRouter key on the job page. Then in THIS Terminal: export GIGSESCROW_PRIVATE_KEY=0x + the 64 hex MetaMask shows (it has no 0x). Not OpenRouter. Then npm run verify:watch"
  );
}

function clientsFor(chainId, account) {
  const meta = CHAINS[chainId] || {
    name: `chain-${chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrl: process.env.GIGSESCROW_RPC,
  };
  const url = meta.rpcUrl;
  const chain = {
    id: chainId,
    name: meta.name,
    nativeCurrency: meta.nativeCurrency,
    rpcUrls: { default: { http: [url] } },
  };
  return {
    publicClient: createPublicClient({ chain, transport: http(url) }),
    walletClient: createWalletClient({ account, chain, transport: http(url) }),
  };
}

async function tickChain(cfg, account, chainId) {
  const meta = await api(cfg.apiBase, `/api/inspect?chainId=${chainId}&status=REQUESTED`);
  const inspect = (cfg.inspect || meta.inspect || "").toLowerCase();
  if (!inspect || inspect === ZERO) {
    console.log(chainId, "skip (FileInspect not deployed)");
    return;
  }

  await api(cfg.apiBase, "/api/inspect/heartbeat", {
    method: "POST",
    body: JSON.stringify({ wallet: account.address, chainId }),
  });

  const { publicClient, walletClient } = clientsFor(chainId, account);
  const active = await publicClient.readContract({
    address: inspect,
    abi: fileInspectAbi,
    functionName: "agentActive",
    args: [account.address],
  });
  const cooldownUntil = await publicClient.readContract({
    address: inspect,
    abi: fileInspectAbi,
    functionName: "agentCooldownUntil",
    args: [account.address],
  });
  const now = Math.floor(Date.now() / 1000);
  const assigned = await api(
    cfg.apiBase,
    `/api/inspect/assigned?wallet=${account.address}&chainId=${chainId}`
  );
  const job = assigned.request;

  if (Number(cooldownUntil) > now && assigned.action === "accept") {
    console.log(chainId, "cooldown", Number(cooldownUntil) - now, "s — release");
    if (job?.id) {
      await api(cfg.apiBase, `/api/inspect/${job.id}/release`, {
        method: "POST",
        body: JSON.stringify({ wallet: account.address }),
      });
    }
    return;
  }
  if (assigned.action === "accept" && job?.id && job.requestId) {
    console.log(chainId, "accept", job.id, job.listing?.title || "");
    const txHash = await walletClient.writeContract({
      address: inspect,
      abi: fileInspectAbi,
      functionName: "accept",
      args: [job.requestId],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    await api(cfg.apiBase, `/api/inspect/${job.id}/accept`, {
      method: "POST",
      body: JSON.stringify({ wallet: account.address, txHash }),
    });
    await api(cfg.apiBase, `/api/inspect/${job.id}/review`, {
      method: "POST",
      body: JSON.stringify({ wallet: account.address }),
    }).catch((err) => console.log("review pending", err.message || err));
    return;
  }
  if (assigned.action === "submit" && job?.id && job.requestId && job.reportHash) {
    const passed = Boolean(job.llmPass);
    console.log(chainId, passed ? "PASS" : "FAIL", job.llmReason || job.reportReason || "", job.llmSummary || "");
    const submitHash = await walletClient.writeContract({
      address: inspect,
      abi: fileInspectAbi,
      functionName: "submit",
      args: [job.requestId, passed, job.reportHash],
    });
    await publicClient.waitForTransactionReceipt({ hash: submitHash });
    await api(cfg.apiBase, `/api/inspect/${job.id}/submit`, {
      method: "POST",
      body: JSON.stringify({
        wallet: account.address,
        txHash: submitHash,
        pass: passed,
        reason: job.llmReason || job.reportReason || (passed ? "match" : "mismatch"),
      }),
    });
    return;
  }
  if (active && active !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
    console.log(chainId, "busy", assigned.action, job?.llmStatus || active);
    return;
  }
  console.log(chainId, assigned.action === "idle" ? "idle" : assigned.action, job?.llmStatus || "");
}

async function watch() {
  const cfg = loadConfig();
  if (!cfg.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(cfg.privateKey)) {
    throw new Error(
      "Set GIGSESCROW_PRIVATE_KEY in THIS Terminal. MetaMask shows 64 hex without 0x — put 0x in front (0x + 64 hex). Same wallet as the site. Not the OpenRouter key."
    );
  }
  const account = privateKeyToAccount(cfg.privateKey);
  console.log("FileInspect watch", account.address, "chains", cfg.chainIds.join(","));
  printRubric();

  while (true) {
    for (const chainId of cfg.chainIds) {
      try {
        await tickChain(cfg, account, chainId);
      } catch (err) {
        console.error("watch", chainId, err.message || err);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
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
} else {
  printRubric();
}
