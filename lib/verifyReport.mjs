/**
 * Local VerifyReport for a decrypted Gig/Job file.
 * The plaintext stays on the caller. This module never uploads it.
 */
import { contentHashOf } from "./deliverCrypto.mjs";

const TEXT_EXT = new Set(["txt", "md", "markdown"]);

function extOf(fileName) {
  const parts = String(fileName || "").toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function startsWith(bytes, ascii) {
  if (!bytes || bytes.length < ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) if (bytes[i] !== ascii.charCodeAt(i)) return false;
  return true;
}

export function detectMime(fileName, bytes) {
  const ext = extOf(fileName);
  if (bytes && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", tool: "png-magic", kind: "png" };
  }
  if (startsWith(bytes, "%PDF")) return { mime: "application/pdf", tool: "pdf-magic", kind: "pdf" };
  if (startsWith(bytes, "PK\u0003\u0004") || startsWith(bytes, "PK\u0005\u0006")) {
    return { mime: "application/zip", tool: "zip-magic", kind: "zip" };
  }
  if (ext === "json") return { mime: "application/json", tool: "json-parse", kind: "json" };
  if (ext === "md" || ext === "markdown") return { mime: "text/markdown", tool: "utf8-text", kind: "text" };
  if (ext === "txt" || TEXT_EXT.has(ext)) return { mime: "text/plain", tool: "utf8-text", kind: "text" };
  return { mime: "application/octet-stream", tool: "content-hash", kind: "exotic" };
}

function briefTokens(brief) {
  return String(brief || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
}

function textOf(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * @param {{ orderId: string, plaintext?: Uint8Array|null, fileName?: string, brief?: string, expectedContentHash?: string, notes?: string }} input
 */
export function buildVerifyReport(input) {
  const checks = [];
  const bytes = input.plaintext instanceof Uint8Array ? input.plaintext : null;
  const detected = detectMime(input.fileName, bytes);
  const tools = [detected.tool];

  if (!bytes || bytes.length === 0) {
    checks.push({ name: "file", result: "fail", detail: "Decrypted file is missing or empty" });
  } else {
    checks.push({ name: "file", result: "pass", detail: `${bytes.length} bytes` });
  }

  const contentHash = bytes && bytes.length ? contentHashOf(bytes) : null;
  const expected = String(input.expectedContentHash || "").toLowerCase();
  if (!contentHash) {
    checks.push({ name: "contentHash", result: "fail", detail: "No content hash" });
  } else if (expected && contentHash !== expected) {
    checks.push({ name: "contentHash", result: "fail", detail: "contentHash does not match the delivery" });
  } else {
    checks.push({ name: "contentHash", result: "pass", detail: contentHash });
  }

  if (detected.kind === "json") {
    try {
      JSON.parse(textOf(bytes || new Uint8Array()));
      checks.push({ name: "json", result: "pass", detail: "JSON parses" });
    } catch {
      checks.push({ name: "json", result: "fail", detail: "JSON does not parse" });
    }
  } else if (detected.kind === "png") {
    checks.push({
      name: "png",
      result: bytes && bytes.length >= 8 ? "pass" : "fail",
      detail: "PNG signature",
    });
  } else if (detected.kind === "pdf") {
    checks.push({ name: "pdf", result: "pass", detail: "PDF signature" });
  } else if (detected.kind === "zip") {
    checks.push({ name: "zip", result: "pass", detail: "ZIP signature" });
  } else if (detected.kind === "text") {
    const text = textOf(bytes || new Uint8Array()).trim();
    const tokens = briefTokens(input.brief);
    const hit = tokens.find((word) => text.toLowerCase().includes(word));
    checks.push({
      name: "brief",
      result: text && (tokens.length === 0 || hit) ? "pass" : "fail",
      detail: hit ? `Brief word present: ${hit}` : "No brief word found in the text",
    });
  } else {
    checks.push({
      name: "human",
      result: "note",
      detail: "Exotic type. Hash is recorded. A person must review the file.",
    });
  }

  const scored = checks.filter((check) => check.result !== "note");
  const passed = scored.filter((check) => check.result === "pass").length;
  const pass = scored.length > 0 && scored.every((check) => check.result === "pass");
  return {
    orderId: input.orderId,
    contentHash,
    mime: detected.mime,
    tools,
    checks,
    pass,
    score: scored.length ? Number((passed / scored.length).toFixed(2)) : 0,
    notes: input.notes || (detected.kind === "exotic" ? "Human review required." : ""),
    createdAt: new Date().toISOString(),
  };
}

const HISTORY_CAP = 20;

/**
 * Decide what to persist. postedBy, role, and postedAt come from the server wallet match.
 * Client copies of those fields are ignored. Buyer and seller columns are independent.
 */
export function applyVerifyPost(input) {
  const clean = publicVerifyReport(input.report);
  if (!clean) return { error: "verifyReportInvalid" };
  const wallet = String(input.wallet || "").toLowerCase();
  const buyer = String(input.buyerWallet || "").toLowerCase();
  const seller = String(input.sellerWallet || "").toLowerCase();
  const role = wallet === buyer ? "buyer" : wallet === seller ? "seller" : "";
  if (!role) return { error: "deliveryForbidden" };
  const expected = String(input.deliveryContentHash || "").toLowerCase();
  if (!expected || clean.contentHash !== expected) return { error: "verifyHashMismatch" };
  const postedAt = new Date().toISOString();
  const stored = { ...clean, postedBy: wallet, role, postedAt };
  const prior = Array.isArray(input.history) ? input.history : [];
  const history = [...prior, { postedBy: wallet, role, postedAt, report: clean }].slice(-HISTORY_CAP);
  const data = {
    verifyReportHistory: history,
    verifyReport: stored,
  };
  if (role === "buyer") data.buyerVerifyReport = stored;
  else data.sellerVerifyReport = stored;
  return { stored, data };
}

/** Drop anything that could be file contents before a report is stored. */
export function publicVerifyReport(report) {
  if (!report || typeof report !== "object") return null;
  const { plaintext, file, bytes, body, content, data, ...rest } = report;
  if (plaintext != null || file != null || bytes != null || content != null || data != null) return null;
  if (typeof body === "string" && body.length > 0) return null;
  if (rest.orderId == null || rest.contentHash == null || !Array.isArray(rest.checks)) return null;
  return {
    orderId: String(rest.orderId),
    contentHash: String(rest.contentHash).toLowerCase(),
    mime: String(rest.mime || ""),
    tools: Array.isArray(rest.tools) ? rest.tools.map(String) : [],
    checks: rest.checks.map((check) => ({
      name: String(check?.name || ""),
      result: String(check?.result || ""),
      detail: String(check?.detail || "").slice(0, 240),
    })),
    pass: Boolean(rest.pass),
    score: Number(rest.score) || 0,
    notes: String(rest.notes || "").slice(0, 500),
    createdAt: String(rest.createdAt || new Date().toISOString()),
  };
}
