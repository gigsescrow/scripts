#!/usr/bin/env node
/**
 * Gig/job arbitration AI CLI. Signs submitScore only.
 * The server keeps inbox + uploads and calls this wallet's OpenRouter key.
 *
 *   node scripts/gigsescrow-arb.mjs init
 *   node scripts/gigsescrow-arb.mjs watch
 *
 * Env: GIGSESCROW_PRIVATE_KEY, GIGSESCROW_API
 * Optional: GIGSESCROW_CHAIN_IDS=5042002,46630
 */
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".gigsescrow-arb");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DEFAULT_API = process.env.GIGSESCROW_API || "https://gigsescrow.com";
const DEFAULT_CHAINS = [5042002, 46630];
const POLL_MS = 15_000;

const CHAINS = {
  5042002: {
    name: "arc-testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrl: process.env.GIGSESCROW_ARC_RPC || "https://rpc.testnet.arc.io",
  },
  46630: {
    name: "robinhood-testnet",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrl: process.env.GIGSESCROW_RH_RPC || "https://rpc.testnet.chain.robinhood.com",
  },
  5042: {
    name: "arc-mainnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrl: process.env.GIGSESCROW_ARC_MAINNET_RPC || "https://rpc.mainnet.arc.io",
  },
};

const DEFAULT_ESCROW = {
  5042002: process.env.NEXT_PUBLIC_ESCROW_ARB_ADDRESS || "0xdD0cc85D68D8fD7F85A61a6AD16aCaCb23e528bE",
  46630:
    process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_ESCROW_ARB_ADDRESS ||
    "0x09F022faB4223E61c180987854F0C17C288b8B1a",
};

function resolveCaseEscrow(job, chainId) {
  const fromCase = String(job?.escrow || "").trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(fromCase)) return fromCase;
  const env = DEFAULT_ESCROW[chainId] || process.env.NEXT_PUBLIC_ESCROW_ARB_ADDRESS || "";
  return /^0x[a-fA-F0-9]{40}$/.test(String(env).trim()) ? String(env).trim() : "";
}

const submitScoreAbi = [
  {
    type: "function",
    name: "submitScore",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "scoreX10", type: "uint16" },
    ],
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

function loadConfig() {
  const file = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
  const privateKey = normalizePrivateKey(process.env.GIGSESCROW_PRIVATE_KEY || file.privateKey || "");
  return {
    apiBase: (process.env.GIGSESCROW_API || file.apiBase || DEFAULT_API).replace(/\/$/, ""),
    chainIds: parseChainIds(process.env.GIGSESCROW_CHAIN_IDS || file.chainIds, DEFAULT_CHAINS),
    privateKey,
  };
}

function printRubric() {
  console.log(`
Gig/job arbitration agent (required CLI — harder than FileInspect)
  FileInspect = one file, HASH + OPEN + pass/fail.
  This seat = disputed gig/job, five axes, 0.0–10.0, Olympic panel.

  Register a wallet + OpenRouter key on the site. This watch loop is mandatory.
  Inbox and uploads stay on the server. Your LLM reads them there.
  Thin evidence (empty inbox + no readable files) is capped at 2.0 (LLM path only).
  Never fetch Drive / X / email / the worker URI.

  Submit score to the escrow on the assigned case (listing.escrowContract).
  Old listings may still be v1; never rewrite that address. Always use the API escrow.
  CLI poll is 15s. You drop from the online pool if heartbeat is older than 120s.

  Clone the public CLI: https://github.com/gigsescrow/scripts

Commands
  npm run arb:init
  npm run arb:watch

Env
  # MetaMask/Rabby show 64 hex WITHOUT 0x. Put 0x in front of those 64 characters.
  # Same wallet you connected on the site. Not the OpenRouter sk-or-… key.
  # export in THIS Terminal, then npm run arb:watch
  export GIGSESCROW_PRIVATE_KEY=0xPASTE_64_HEX_FROM_METAMASK
  export GIGSESCROW_API=${DEFAULT_API}

Pay
  ~0.8% of locked escrow after settle (one fifth of the 4% panel fee).
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
    chainIds: parseChainIds(process.env.GIGSESCROW_CHAIN_IDS || current.chainIds, DEFAULT_CHAINS),
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  console.log("Wrote", CONFIG_PATH);
  printRubric();
  console.log(
    "Required: OpenRouter key on the job page. Then in THIS Terminal: export GIGSESCROW_PRIVATE_KEY=0x + the 64 hex MetaMask shows (it has no 0x). Not OpenRouter. Then npm run arb:watch"
  );
}

function clientsFor(chainId, account, rpcUrl) {
  const meta = CHAINS[chainId] || {
    name: `chain-${chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrl,
  };
  const chain = {
    id: chainId,
    name: meta.name,
    nativeCurrency: meta.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl || meta.rpcUrl] } },
  };
  const url = rpcUrl || meta.rpcUrl;
  return {
    publicClient: createPublicClient({ chain, transport: http(url) }),
    walletClient: createWalletClient({ account, chain, transport: http(url) }),
  };
}

async function tickChain(cfg, account, chainId) {
  await api(cfg.apiBase, "/api/arb/heartbeat", {
    method: "POST",
    body: JSON.stringify({ wallet: account.address, chainId }),
  });

  const assigned = await api(
    cfg.apiBase,
    `/api/arb/assigned?wallet=${account.address}&chainId=${chainId}`
  );
  const job = assigned.case;
  if (assigned.action === "idle" || !job?.id) {
    console.log(chainId, "idle");
    return;
  }

  if (assigned.action === "wait") {
    console.log(chainId, "review", job.listingTitle || job.id, job.llmStatus || "pending");
    if (!job.llmStatus || job.llmStatus === "pending" || job.llmStatus === "error") {
      await api(cfg.apiBase, `/api/arb/cases/${job.id}/review`, {
        method: "POST",
        body: JSON.stringify({ wallet: account.address }),
      }).catch((err) => console.log("review pending", err.message || err));
    }
    return;
  }

  if (assigned.action === "submit" && job.orderBytes32 && job.llmScoreX10 != null) {
    const escrow = resolveCaseEscrow(job, chainId);
    if (!escrow) {
      console.log(chainId, "submit skipped: no listing.escrowContract / env escrow");
      return;
    }
    const rpcUrl = job.rpcUrl || CHAINS[chainId]?.rpcUrl;
    const { publicClient, walletClient } = clientsFor(chainId, account, rpcUrl);
    const score = Number(job.llmScoreX10);
    console.log(
      chainId,
      "SCORE",
      (score / 10).toFixed(1),
      escrow,
      job.llmReason || "",
      job.llmSummary || "",
      job.listingTitle || ""
    );
    const txHash = await walletClient.writeContract({
      address: escrow,
      abi: submitScoreAbi,
      functionName: "submitScore",
      args: [job.orderBytes32, score],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    await api(cfg.apiBase, `/api/arb/cases/${job.id}/score`, {
      method: "POST",
      body: JSON.stringify({
        wallet: account.address,
        txHash,
        scoreX10: score,
      }),
    });
    return;
  }

  console.log(chainId, assigned.action, job.llmStatus || "");
}

async function watch() {
  const cfg = loadConfig();
  if (!cfg.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(cfg.privateKey)) {
    throw new Error(
      "Set GIGSESCROW_PRIVATE_KEY in THIS Terminal. MetaMask shows 64 hex without 0x — put 0x in front (0x + 64 hex). Same wallet as the site. Not the OpenRouter key."
    );
  }
  const account = privateKeyToAccount(cfg.privateKey);
  console.log("Arbitration watch", account.address, "chains", cfg.chainIds.join(","));
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
