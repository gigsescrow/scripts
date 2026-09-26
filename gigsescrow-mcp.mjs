#!/usr/bin/env node
/**
 * Read-only GigsEscrow MCP over public HTTP (stdio JSON-RPC).
 * GET only. No private keys. No transactions.
 *
 *   node scripts/gigsescrow-mcp.mjs
 *
 * Env: GIGSESCROW_API (default https://gigsescrow.com)
 *
 * Sign with scripts/gigsescrow-*.mjs only.
 */
import { createInterface } from "node:readline";

const PROTOCOL = "2024-11-05";
const API = String(process.env.GIGSESCROW_API || "https://gigsescrow.com").replace(/\/$/, "");
const CHAIN_IDS = [5042, 5042002, 46630];
const KINDS = ["SERVICE", "FILE", "TOKEN", "CAMPAIGN"];

const TOOLS = [
  {
    name: "catalog",
    description:
      "GET /api/listings. ACTIVE catalog. priceUsdc is a string integer with 6 decimals. Read listing.escrowContract from listing(). Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        chainId: { type: "integer", enum: CHAIN_IDS, description: "5042 | 5042002 | 46630" },
        kind: { type: "string", enum: KINDS },
        q: { type: "string", description: "Title/description search, max 80 chars" },
      },
    },
  },
  {
    name: "listing",
    description:
      "GET /api/listings/:id. Always use listing.escrowContract from this payload. Never rewrite it. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "offers",
    description:
      "GET /api/listings/:id/offers. Owner sees every OPEN/ACCEPTED offer; a worker sees only their own. Wallet is required by that HTTP route. Read-only — this does not hire or lock.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["listingId"],
      properties: {
        listingId: { type: "string" },
        wallet: { type: "string", description: "Owner or worker address (query wallet=)" },
      },
    },
  },
  {
    name: "inspectAssigned",
    description:
      "GET /api/inspect/assigned. Returns action accept|submit|wait|idle. Read-only — do not accept or submit through MCP. Sign with scripts/gigsescrow-verify.mjs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["wallet", "chainId"],
      properties: {
        wallet: { type: "string" },
        chainId: { type: "integer", enum: CHAIN_IDS },
      },
    },
  },
  {
    name: "arbAssigned",
    description:
      "GET /api/arb/assigned. Returns action submit|wait|idle. Read-only — do not submitScore through MCP. Sign with scripts/gigsescrow-arb.mjs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["wallet", "chainId"],
      properties: {
        wallet: { type: "string" },
        chainId: { type: "integer", enum: CHAIN_IDS },
      },
    },
  },
  {
    name: "myOrders",
    description:
      "GET /api/orders?role=seller. Worker in-process SERVICE orders by default. Always passes role=seller (omit role and the HTTP route injects inspect/arb desk rows). Read listing.escrowContract. Read-only — sign deliver with scripts/gigsescrow-gig.mjs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["wallet"],
      properties: {
        wallet: { type: "string" },
        chainId: { type: "integer", enum: CHAIN_IDS, description: "5042 | 5042002 | 46630" },
        kind: { type: "string", enum: KINDS, description: "Default SERVICE" },
        bucket: {
          type: "string",
          enum: ["in_process", "history"],
          description: "Default in_process",
        },
      },
    },
  },
  {
    name: "getOrder",
    description:
      "GET /api/orders/:id. listing.escrowContract + escrowId for deliver bytes32. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "myHires",
    description:
      "GET /api/orders?role=buyer. Hirer in-process SERVICE orders by default. Always passes role=buyer. Read listing.escrowContract. Read-only — sign lock/release with scripts/gigsescrow-hire.mjs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["wallet"],
      properties: {
        wallet: { type: "string" },
        chainId: { type: "integer", enum: CHAIN_IDS, description: "5042 | 5042002 | 46630" },
        kind: { type: "string", enum: KINDS, description: "Default SERVICE" },
        bucket: {
          type: "string",
          enum: ["in_process", "history"],
          description: "Default in_process",
        },
      },
    },
  },
];

function help() {
  return [
    "GigsEscrow read-only MCP. Public GET over HTTP. Stdio JSON-RPC.",
    "",
    "  node scripts/gigsescrow-mcp.mjs",
    "",
    "Env: GIGSESCROW_API (default https://gigsescrow.com)",
    "",
    "Tools: catalog, listing, offers, inspectAssigned, arbAssigned, myOrders, getOrder, myHires",
    "myOrders always role=seller. myHires always role=buyer. This process never stores a private key and never sends a transaction.",
    "Sign with scripts/gigsescrow-*.mjs only (gig:watch / hire:watch / verify:watch / arb:watch).",
    "Posting a job is not a tool. POST /api/listings origin=BUYER_JOB. No signature. No lock.",
    "",
  ].join("\n");
}

function parseChainId(raw) {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (CHAIN_IDS.includes(n)) return n;
  return null;
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function toolText(obj, isError = false) {
  return {
    content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function publicGet(path) {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  if (!res.ok) {
    return toolText({ status: res.status, url, body, hint: "read-only GET failed" }, true);
  }
  return toolText({ url, body });
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

async function callTool(name, args) {
  const a = args && typeof args === "object" ? args : {};
  switch (name) {
    case "catalog": {
      const chainId = a.chainId == null || a.chainId === "" ? undefined : parseChainId(a.chainId);
      if (a.chainId != null && a.chainId !== "" && chainId == null) {
        return toolText({ error: "chainId must be 5042, 5042002, or 46630" }, true);
      }
      const kind = a.kind ? String(a.kind).toUpperCase() : "";
      if (kind && !KINDS.includes(kind)) {
        return toolText({ error: "kind must be SERVICE, FILE, TOKEN, or CAMPAIGN" }, true);
      }
      return publicGet(
        `/api/listings${qs({
          chainId,
          kind: kind || undefined,
          q: a.q ? String(a.q).trim().slice(0, 80) : undefined,
          limit: 12,
        })}`
      );
    }
    case "listing": {
      const id = String(a.id || "").trim();
      if (!id) return toolText({ error: "id required" }, true);
      return publicGet(`/api/listings/${encodeURIComponent(id)}`);
    }
    case "offers": {
      const listingId = String(a.listingId || "").trim();
      if (!listingId) return toolText({ error: "listingId required" }, true);
      const wallet = String(a.wallet || "").trim();
      return publicGet(
        `/api/listings/${encodeURIComponent(listingId)}/offers${qs({ wallet: wallet || undefined })}`
      );
    }
    case "inspectAssigned": {
      const wallet = String(a.wallet || "").trim();
      const chainId = parseChainId(a.chainId);
      if (!wallet) return toolText({ error: "wallet required" }, true);
      if (chainId == null) return toolText({ error: "chainId must be 5042, 5042002, or 46630" }, true);
      return publicGet(`/api/inspect/assigned${qs({ wallet, chainId })}`);
    }
    case "arbAssigned": {
      const wallet = String(a.wallet || "").trim();
      const chainId = parseChainId(a.chainId);
      if (!wallet) return toolText({ error: "wallet required" }, true);
      if (chainId == null) return toolText({ error: "chainId must be 5042, 5042002, or 46630" }, true);
      return publicGet(`/api/arb/assigned${qs({ wallet, chainId })}`);
    }
    case "myOrders": {
      const wallet = String(a.wallet || "").trim();
      if (!wallet) return toolText({ error: "wallet required" }, true);
      const chainId =
        a.chainId == null || a.chainId === "" ? undefined : parseChainId(a.chainId);
      if (a.chainId != null && a.chainId !== "" && chainId == null) {
        return toolText({ error: "chainId must be 5042, 5042002, or 46630" }, true);
      }
      const kind = a.kind ? String(a.kind).toUpperCase() : "SERVICE";
      if (!KINDS.includes(kind)) {
        return toolText({ error: "kind must be SERVICE, FILE, TOKEN, or CAMPAIGN" }, true);
      }
      const bucket = a.bucket ? String(a.bucket) : "in_process";
      if (bucket !== "in_process" && bucket !== "history") {
        return toolText({ error: "bucket must be in_process or history" }, true);
      }
      return publicGet(
        `/api/orders${qs({
          wallet,
          role: "seller",
          bucket,
          kind,
          chainId,
        })}`
      );
    }
    case "getOrder": {
      const id = String(a.id || "").trim();
      if (!id) return toolText({ error: "id required" }, true);
      return publicGet(`/api/orders/${encodeURIComponent(id)}`);
    }
    case "myHires": {
      const wallet = String(a.wallet || "").trim();
      if (!wallet) return toolText({ error: "wallet required" }, true);
      const chainId =
        a.chainId == null || a.chainId === "" ? undefined : parseChainId(a.chainId);
      if (a.chainId != null && a.chainId !== "" && chainId == null) {
        return toolText({ error: "chainId must be 5042, 5042002, or 46630" }, true);
      }
      const kind = a.kind ? String(a.kind).toUpperCase() : "SERVICE";
      if (!KINDS.includes(kind)) {
        return toolText({ error: "kind must be SERVICE, FILE, TOKEN, or CAMPAIGN" }, true);
      }
      const bucket = a.bucket ? String(a.bucket) : "in_process";
      if (bucket !== "in_process" && bucket !== "history") {
        return toolText({ error: "bucket must be in_process or history" }, true);
      }
      return publicGet(
        `/api/orders${qs({
          wallet,
          role: "buyer",
          bucket,
          kind,
          chainId,
        })}`
      );
    }
    default:
      return toolText({ error: `unknown tool: ${name}` }, true);
  }
}

function handle(msg) {
  if (!msg || typeof msg !== "object") return jsonRpcError(null, -32600, "invalid request");
  const { id, method, params } = msg;
  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "GigsEscrow", version: "2026-09-22" },
      instructions:
        "Read-only catalog, assignment, and order GETs. myOrders uses role=seller. myHires uses role=buyer. Sign with scripts/gigsescrow-gig.mjs or gigsescrow-hire.mjs. Posting a job is POST /api/listings origin=BUYER_JOB with no signature and no lock — not a tool here. Never send a tx or private key through this server.",
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return null;
  }
  if (method === "ping") return jsonRpcResult(id, {});
  if (method === "tools/list") return jsonRpcResult(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    return callTool(name, args).then((result) => jsonRpcResult(id, result));
  }
  if (id === undefined) return null;
  return jsonRpcError(id, -32601, `method not found: ${method}`);
}

function send(msg) {
  if (!msg) return;
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(help());
    return;
  }
  process.stdin.setEncoding("utf8");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const raw = String(line || "").trim();
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(jsonRpcError(null, -32700, "parse error"));
      continue;
    }
    try {
      const out = await handle(parsed);
      send(out);
    } catch (err) {
      send(jsonRpcError(parsed.id ?? null, -32603, err instanceof Error ? err.message : "internal error"));
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
