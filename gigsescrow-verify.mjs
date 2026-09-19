#!/usr/bin/env node
/**
 * FileInspect agent CLI. Signs accept/submit only.
 * The server keeps the seller file and calls the agent's OpenRouter key.
 *
 *   node gigsescrow-verify.mjs init
 *   node gigsescrow-verify.mjs watch
 *
 * Env: GIGSESCROW_PRIVATE_KEY, GIGSESCROW_API, GIGSESCROW_RPC, GIGSESCROW_CHAIN_ID
 */
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".gigsescrow-verify");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DEFAULT_API = process.env.GIGSESCROW_API || "https://gigsescrow.com";
const DEFAULT_RPC =
  process.env.GIGSESCROW_RPC || "https://rpc.testnet.chain.robinhood.com";
const DEFAULT_CHAIN_ID = Number(process.env.GIGSESCROW_CHAIN_ID || 46630);
const POLL_MS = 15_000;

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

function loadConfig() {
  const file = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
  const privateKey = (process.env.GIGSESCROW_PRIVATE_KEY || file.privateKey || "").trim();
  return {
    apiBase: (process.env.GIGSESCROW_API || file.apiBase || DEFAULT_API).replace(/\/$/, ""),
    rpcUrl: process.env.GIGSESCROW_RPC || file.rpcUrl || DEFAULT_RPC,
    chainId: Number(process.env.GIGSESCROW_CHAIN_ID || file.chainId || DEFAULT_CHAIN_ID),
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
  export GIGSESCROW_PRIVATE_KEY=0x…   # WALLET private key of the connected agent address
  export GIGSESCROW_API=${DEFAULT_API}

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
    rpcUrl: process.env.GIGSESCROW_RPC || current.rpcUrl || DEFAULT_RPC,
    chainId: Number(process.env.GIGSESCROW_CHAIN_ID || current.chainId || DEFAULT_CHAIN_ID),
    inspect: process.env.GIGSESCROW_INSPECT || current.inspect || "",
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  console.log("Wrote", CONFIG_PATH);
  printRubric();
  console.log("Required: OpenRouter key on the job page. GIGSESCROW_PRIVATE_KEY = that wallet's private key (0x…), then npm run verify:watch");
}

async function watch() {
  const cfg = loadConfig();
  if (!cfg.privateKey || !cfg.privateKey.startsWith("0x")) {
    throw new Error("Set GIGSESCROW_PRIVATE_KEY=0x… to your WALLET private key (never commit it, not the OpenRouter key)");
  }
  const account = privateKeyToAccount(cfg.privateKey);
  const chain = {
    id: cfg.chainId,
    name: "robinhood-testnet",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  };
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });

  const meta = await api(cfg.apiBase, `/api/inspect?chainId=${cfg.chainId}&status=REQUESTED`);
  const inspect = (cfg.inspect || meta.inspect || "").toLowerCase();
  if (!inspect || inspect === "0x0000000000000000000000000000000000000000") {
    throw new Error("FileInspect is not configured. Deploy it on Robinhood testnet first.");
  }

  console.log("FileInspect watch", account.address, "chain", cfg.chainId);
  printRubric();

  while (true) {
    try {
      await api(cfg.apiBase, "/api/inspect/heartbeat", {
        method: "POST",
        body: JSON.stringify({ wallet: account.address, chainId: cfg.chainId }),
      });

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
        `/api/inspect/assigned?wallet=${account.address}&chainId=${cfg.chainId}`
      );
      const job = assigned.request;

      if (Number(cooldownUntil) > now && assigned.action === "accept") {
        console.log("cooldown", Number(cooldownUntil) - now, "s — release");
        if (job?.id) {
          await api(cfg.apiBase, `/api/inspect/${job.id}/release`, {
            method: "POST",
            body: JSON.stringify({ wallet: account.address }),
          });
        }
      } else if (assigned.action === "accept" && job?.id && job.requestId) {
        console.log("accept", job.id, job.listing?.title || "");
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
      } else if (assigned.action === "submit" && job?.id && job.requestId && job.reportHash) {
        const passed = Boolean(job.llmPass);
        console.log(passed ? "PASS" : "FAIL", job.llmReason || job.reportReason || "", job.llmSummary || "");
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
      } else if (active && active !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        console.log("busy", assigned.action, job?.llmStatus || active);
      } else {
        console.log(assigned.action === "idle" ? "idle" : assigned.action, job?.llmStatus || "");
      }
    } catch (err) {
      console.error("watch:", err.message || err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const cmd = process.argv[2] || "help";
if (cmd === "init") init().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
else if (cmd === "watch") watch().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
else printRubric();
