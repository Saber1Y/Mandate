#!/usr/bin/env node
/**
 * Mandate MCP server.
 *
 * Exposes one Mandate agent's spending API as Model Context Protocol tools, so a model can call
 * `request_payment` as a native tool instead of hand-rolling curl calls and inventing endpoint
 * shapes. That was the last missing piece of the intended flow:
 *
 *   human creates a policy and a key -> hands the key to an agent -> agent calls the API
 *
 * The handoff prompt tells a model what to do; this is what lets it actually do it.
 *
 * Transport is stdio: newline-delimited JSON-RPC 2.0, which is the MCP stdio transport. Implemented
 * directly against the spec rather than via the SDK so the server adds no dependency to a project
 * whose whole argument is that it needs almost nothing.
 *
 * Credentials come from the environment, never from a tool argument. A model must not be able to
 * read or choose the key it spends with, and no tool accepts a URL or a key, so prompt injection
 * cannot redirect this server at another host or another treasury.
 *
 * Usage (stdio):
 *   MANDATE_API_KEY=mdt_... MANDATE_API_BASE=http://localhost:3000 node mcp/server.mjs
 *
 * Usage (check by hand):
 *   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp/server.mjs
 */

import {createHash, randomBytes} from "node:crypto";
import {createInterface} from "node:readline";

const API_KEY = process.env.MANDATE_API_KEY ?? "";
const BASE = (process.env.MANDATE_API_BASE ?? "http://localhost:3000").replace(/\/+$/, "");
const TOKEN_DECIMALS = 6;
const SERVER_NAME = "mandate";
const SERVER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** JSON-RPC error codes, including the implementation-defined -32000 range MCP uses for tool errors. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL = -32603;
const TOOL_ERROR = -32000;

// ---------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------

/** Base units -> human decimal, for showing an agent numbers it can reason about. */
function human(base) {
  const n = typeof base === "bigint" ? base : BigInt(base ?? 0);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = abs / 10n ** BigInt(TOKEN_DECIMALS);
  const frac = (abs % 10n ** BigInt(TOKEN_DECIMALS)).toString().padStart(TOKEN_DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isBytes32(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Parse a human tUSDT string into base units. Rejects anything ambiguous rather than rounding. */
function toBaseUnits(value, field) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${field} must be sent as a string of base units, not a float.`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error(
    `${field} must be an integer string in base units (1 tUSDT = 1000000), e.g. "2500000" for 2.5. ` +
      `Decimals are rejected on purpose: "${value}" would have to be rounded to a value nobody chose.`,
  );
}

async function callApi(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      ...(init.body ? {"content-type": "application/json"} : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = {raw: text.slice(0, 200)};
  }
  return {status: res.status, body};
}

/**
 * A tool result is content plus a flag, not a bare value: the model has to read prose, and the
 * on-chain verdict has to survive into that prose instead of being summarised away.
 */
function text(value) {
  return {content: [{type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2)}]};
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

const TOOLS = [
  {
    name: "get_budget",
    description:
      "Read your live spending leash from the Mandate vault: per-transaction cap, daily cap, " +
      "spent today, remaining today, whether tUSDT is allowed, whether an owner signature is " +
      "required, and the vault balance. Call this before spending so you know what is actually " +
      "permitted rather than assuming. Values are returned in both base units and as tUSDT.",
    inputSchema: {type: "object", properties: {}, additionalProperties: false},
    annotations: {readOnlyHint: true, openWorldHint: false},
  },
  {
    name: "check_spend",
    description:
      "Check whether a payment would be permitted, WITHOUT sending anything. Returns the verdict " +
      "the vault's own policy rules imply: per-transaction cap, remaining daily cap, token " +
      "allowlist and vault balance. Use this to avoid a doomed request. It cannot know whether a " +
      "recipient is allowlisted, so a permitted result still needs request_payment to be certain.",
    inputSchema: {
      type: "object",
      properties: {
        amount: {type: "string", description: 'Amount in base units as an integer string, e.g. "2500000" for 2.5 tUSDT.'},
      },
      required: ["amount"],
      additionalProperties: false,
    },
    annotations: {readOnlyHint: true, openWorldHint: false},
  },
  {
    name: "request_payment",
    description:
      "Request a payment from your Mandate vault. The vault decides: if the request is inside your " +
      "leash it is approved (and may settle immediately); if it breaks policy it is refused and " +
      "nothing happens. Returns the requestId and the on-chain verdict. A refusal is a final " +
      "answer - do not retry with a larger or split amount to get around it.",
    inputSchema: {
      type: "object",
      properties: {
        amount: {type: "string", description: 'Amount in base units as an integer string, e.g. "2500000" for 2.5 tUSDT. Decimals are rejected.'},
        recipient: {type: "string", description: "Address to pay. Must be allowlisted on this vault or the request is refused."},
        idempotencyKey: {
          type: "string",
          description:
            "Optional 32-byte hex key. Omit to have one generated. Reuse the same key when retrying " +
            "the same payment so a retry cannot become two payments; never reuse a key for a different payment.",
        },
      },
      required: ["amount", "recipient"],
      additionalProperties: false,
    },
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false},
  },
  {
    name: "settle_payment",
    description:
      "Settle a previously approved request. Only needed when your vault requires an owner " +
      "signature; if approvals were not required the request is usually already settled. " +
      "Refuses a request that has not been approved.",
    inputSchema: {
      type: "object",
      properties: {requestId: {type: "string", description: "The 32-byte request id returned by request_payment."}},
      required: ["requestId"],
      additionalProperties: false,
    },
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  },
  {
    name: "get_request",
    description:
      "Read one request back from the chain: who asked, how much, to whom, and its current status " +
      "(Pending, Approved, Executed, Rejected, Cancelled, Expired).",
    inputSchema: {
      type: "object",
      properties: {requestId: {type: "string", description: "The 32-byte request id."}},
      required: ["requestId"],
      additionalProperties: false,
    },
    annotations: {readOnlyHint: true, openWorldHint: false},
  },
  {
    name: "list_rejections",
    description:
      "Recent requests the vault refused, with the reason. A Mandate request that breaks policy " +
      "reverts and leaves no record on chain, so this is the only place a refusal is visible. " +
      "Read this when a payment does not go through: it tells you which rule stopped it.",
    inputSchema: {
      type: "object",
      properties: {limit: {type: "integer", description: "How many recent refusals to return (1-100, default 10)."}},
      additionalProperties: false,
    },
    annotations: {readOnlyHint: true, openWorldHint: false},
  },
];

async function describeBudget() {
  const {status, body} = await callApi("/api/agents/me");
  if (status !== 200) {
    throw new Error(`Could not read your leash (HTTP ${status}): ${body?.error ?? "unknown error"}`);
  }
  const p = body.policy;
  return {
    agentId: body.agentId,
    agentAddress: body.agentAddress,
    vault: body.vault,
    chainId: body.chainId,
    registeredOnChain: body.registeredOnChain,
    tUSDT: {
      maxPerTx: {base: p.maxPerTx, display: human(p.maxPerTx)},
      dailyCap: {base: p.dailyCap, display: human(p.dailyCap)},
      spentToday: {base: p.spentToday, display: human(p.spentToday)},
      remainingToday: {base: p.remainingDailyCap, display: human(p.remainingDailyCap)},
    },
    tokenAllowed: body.tokenAllowed,
    approvalThreshold: p.approvalThreshold,
    ownerSignatureRequired: p.approvalThreshold > 0,
    policyActive: p.active,
    policyExpiryTimestamp: p.expiry,
    policyExpiry: p.expiry === 0 ? "never" : new Date(p.expiry * 1000).toISOString(),
    vaultBalance: {base: body.treasuryBalance, display: human(body.treasuryBalance)},
  };
}

async function runCheckSpend(args) {
  const amount = toBaseUnits(args.amount, "amount");
  const budget = await describeBudget();

  const problems = [];
  if (!budget.registeredOnChain) problems.push("You are not registered as an agent on this vault.");
  if (!budget.policyActive) problems.push("Your policy is inactive, so every request is refused.");
  if (
    Number(budget.policyExpiryTimestamp) > 0 &&
    Math.floor(Date.now() / 1000) > Number(budget.policyExpiryTimestamp)
  ) {
    problems.push(`Your policy expired at ${budget.policyExpiry}. Every request is refused until the owner renews it.`);
  }
  if (!budget.tokenAllowed) problems.push("tUSDT is not allowlisted for you, so every request is refused.");
  if (amount <= 0n) problems.push("Amount must be greater than zero.");
  if (amount > BigInt(budget.tUSDT.maxPerTx.base)) {
    problems.push(
      `Amount ${human(amount)} tUSDT is over your ${human(budget.tUSDT.maxPerTx.base)} per-transaction cap.`,
    );
  }
  if (amount > BigInt(budget.tUSDT.remainingToday.base)) {
    problems.push(
      `Amount ${human(amount)} tUSDT exceeds the ${human(budget.tUSDT.remainingToday.base)} tUSDT left in your daily cap.`,
    );
  }
  if (amount > BigInt(budget.vaultBalance.base)) {
    problems.push(`The vault holds only ${human(budget.vaultBalance.base)} tUSDT.`);
  }

  return {
    wouldBeAccepted: problems.length === 0,
    amount: {base: amount.toString(), display: human(amount)},
    problems,
    note:
      "This does not check whether the recipient is allowlisted, which only the vault can decide. " +
      "Use request_payment for the real answer.",
  };
}

async function runRequestPayment(args) {
  const amount = toBaseUnits(args.amount, "amount");
  if (!isAddress(args.recipient)) {
    throw new Error("recipient must be a 20-byte hex address, 0x followed by 40 hex characters.");
  }
  const idempotencyKey =
    args.idempotencyKey === undefined || args.idempotencyKey === null
      ? `0x${randomBytes(32).toString("hex")}`
      : args.idempotencyKey;
  if (!isBytes32(idempotencyKey)) {
    throw new Error("idempotencyKey must be 32 bytes of hex, 0x followed by 64 hex characters.");
  }

  const {status, body} = await callApi("/api/requests", {
    method: "POST",
    body: JSON.stringify({amount: amount.toString(), recipient: args.recipient, idempotencyKey}),
  });

  if (status === 201) {
    return {
      accepted: true,
      requestId: body.requestId,
      status: body.status,
      approvals: body.approvals,
      amount: {base: body.amount, display: human(body.amount)},
      recipient: body.recipient,
      expiresAt: body.expiresAt,
      transaction: body.requestTxHash,
      nextStep:
        body.status === "Approved"
          ? "Already approved. Call settle_payment to move the funds."
          : "Waiting for an owner or approver to sign. It settles after that.",
      idempotencyKey,
    };
  }

  // A refusal is a real answer, not a failure of this tool. Report it as data so the model reads
  // the rule rather than retrying, and keep the key so an accidental repeat is not a second payment.
  return {
    accepted: false,
    refusedBy: "vault",
    reason: body?.reason ?? null,
    message: body?.error ?? `HTTP ${status}`,
    amount: {base: amount.toString(), display: human(amount)},
    recipient: args.recipient,
    idempotencyKey,
    nextStep:
      "This is the vault's decision and it is final for these parameters. Do not retry with a " +
      "larger or split amount. Use list_rejections for the rule, or ask your owner to widen the leash.",
  };
}

async function runSettlePayment(args) {
  if (!isBytes32(args.requestId)) {
    throw new Error("requestId must be 32 bytes of hex, 0x followed by 64 hex characters.");
  }
  const {status, body} = await callApi(`/api/requests/${args.requestId}/execute`, {method: "POST"});
  if (status === 200) {
    return {settled: true, requestId: body.requestId, status: body.status, transaction: body.executeTxHash};
  }
  return {
    settled: false,
    requestId: args.requestId,
    reason: body?.reason ?? null,
    message: body?.error ?? `HTTP ${status}`,
    nextStep:
      body?.reason === "RequestNotApproved"
        ? "This request still needs an owner signature before it can settle."
        : body?.reason === "RequestFinalized"
          ? "This request already reached a terminal state; nothing more to do."
          : "The vault refused to settle. Nothing moved.",
  };
}

async function runGetRequest(args) {
  if (!isBytes32(args.requestId)) {
    throw new Error("requestId must be 32 bytes of hex, 0x followed by 64 hex characters.");
  }
  const {status, body} = await callApi(`/api/requests/${args.requestId}`);
  if (status !== 200) {
    throw new Error(`Could not read the request (HTTP ${status}): ${body?.error ?? "unknown error"}`);
  }
  return {...body, amountDisplay: human(body.amount)};
}

async function runListRejections(args) {
  const limit = Math.max(1, Math.min(100, Number(args.limit ?? 10)));
  const {status, body} = await callApi(`/api/agents/attempts?limit=${limit}`);
  if (status !== 200) throw new Error(`Could not load refusals (HTTP ${status}).`);
  return {
    note:
      "These are requests the vault refused. A refusal reverts and leaves no on-chain record, so " +
      "this list is the only trace of it.",
    refusals: (body.attempts ?? []).map((a) => ({
      recipient: a.recipient,
      amount: a.amount,
      amountDisplay: human(a.amount),
      reason: a.reason,
      explanation: a.detail,
      when: new Date(a.createdAt).toISOString(),
    })),
  };
}

const HANDLERS = {
  get_budget: {run: () => describeBudget()},
  check_spend: {run: runCheckSpend},
  request_payment: {run: runRequestPayment},
  settle_payment: {run: runSettlePayment},
  get_request: {run: runGetRequest},
  list_rejections: {run: runListRejections},
};

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

async function dispatch(method, params) {
  switch (method) {
    case "initialize":
      return {
        // Echo the client's version when we speak it, otherwise offer ours and let it decide.
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSIONS[0],
        capabilities: {tools: {listChanged: false}},
        serverInfo: {name: SERVER_NAME, version: SERVER_VERSION},
        instructions:
          "You control a Mandate treasury through an on-chain spending policy. The vault, not you, " +
          "decides whether money moves. Read get_budget before spending, and treat a refusal as final.",
      };
    case "notifications/initialized":
    case "initialized":
      return undefined; // notification: no response
    case "ping":
      return {};
    case "tools/list":
      return {tools: TOOLS};
    case "tools/call": {
      const name = params?.name;
      const handler = HANDLERS[name];
      if (!handler) throw new Error(`Unknown tool: ${name}`);
      // A tool call result is a content envelope, not a bare value: the model reads text, and the
      // on-chain verdict has to survive into that text rather than being summarised away.
      const value = await handler.run(params.arguments ?? {});
      return text(value);
    }
    default:
      const err = new Error(`Method not found: ${method}`);
      err.rpcCode = METHOD_NOT_FOUND;
      throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------------------------

/**
 * A reply to send, or null for a notification that must not be answered.
 *
 * Returning the decision instead of writing straight to stdout is what lets the same protocol core
 * serve stdio and HTTP without either transport owning the JSON-RPC semantics.
 */
async function handle(message) {
  const {id, method, params} = message ?? {};

  if (message === null || typeof message !== "object" || typeof method !== "string") {
    if (id !== undefined) return {error: {code: INVALID_REQUEST, message: "Request must be a JSON-RPC object with a method."}};
    return null;
  }

  try {
    const result = await dispatch(method, params);
    // A notification has no id and must not be answered, or clients report a protocol error.
    if (id === undefined || id === null) return null;
    return {jsonrpc: "2.0", id, result: result ?? {}};
  } catch (e) {
    const err = /** @type {Error & {rpcCode?: number}} */ (e);
    if (id === undefined || id === null) return null;
    return {jsonrpc: "2.0", id, error: {code: err.rpcCode ?? TOOL_ERROR, message: err.message ?? "Tool failed"}};
  }
}

async function serveStdio() {
  const rl = createInterface({input: process.stdin, crlfDelay: Infinity});

  // Requests are handled strictly in order. Two concurrent spends sharing a generated idempotency
  // key ordering would be a real hazard, and serialising costs nothing at human request rates.
  let queue = Promise.resolve();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        send({jsonrpc: "2.0", id: null, error: {code: PARSE_ERROR, message: "Invalid JSON"}});
        return;
      }
      for (const entry of Array.isArray(message) ? message : [message]) {
        const reply = await handle(entry);
        if (reply) send(reply);
      }
    });
  }
}

/**
 * Streamable HTTP transport.
 *
 * Exists so the server can be hosted rather than spawned by each client. A single POST carries one
 * JSON-RPC message (or a batch) and the response is the reply, or 202 with no body for a notification -
 * which is the shape the Streamable HTTP transport specifies for a request/response exchange.
 *
 * Deliberately NOT stateless JSON-RPC: a real spend needs a session, and giving every caller an
 * unauthenticated session that can move money would undo the key-scoped design. Sessions are issued
 * here and each still carries the same single agent key from the environment.
 */
async function serveHttp() {
  const {createServer} = await import("node:http");
  const port = Number(process.env.MANDATE_MCP_PORT ?? 8787);

  /** @type {Map<string, {createdAt: number}>} */
  const sessions = new Map();
  const SESSION_TTL_MS = 30 * 60 * 1000;

  function newSessionId() {
    return randomBytes(24).toString("hex");
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Docker and load balancers probe this; keep it dependency-free and always cheap.
    if (url.pathname === "/healthz") {
      res.writeHead(200, {"content-type": "application/json"});
      res.end(JSON.stringify({ok: true, tools: TOOLS.length}));
      return;
    }

    if (url.pathname !== "/mcp" || req.method !== "POST") {
      res.writeHead(405, {allow: "POST"});
      res.end();
      return;
    }

    let body = "";
    req.on("data", (c) => {
      body += c;
      // A spending tool takes no arguments worth megabytes; refuse rather than buffer.
      if (body.length > 1_000_000) req.destroy();
    });

    req.on("end", async () => {
      let message;
      try {
        message = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, {"content-type": "application/json"});
        res.end(JSON.stringify({jsonrpc: "2.0", id: null, error: {code: PARSE_ERROR, message: "Invalid JSON"}}));
        return;
      }

      const isInitialize = !Array.isArray(message) && message?.method === "initialize";
      const sessionId = isInitialize ? newSessionId() : req.headers["mcp-session-id"];

      // Session-bearing requests must present a session. Without this the endpoint is an
      // unauthenticated spend oracle for anyone who can reach the port.
      if (!isInitialize) {
        const known = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
        if (!known) {
          res.writeHead(403, {"content-type": "application/json"});
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: {code: INVALID_REQUEST, message: "Unknown or expired MCP session. Send initialize first."},
            }),
          );
          return;
        }
        if (Date.now() - known.createdAt > SESSION_TTL_MS) {
          sessions.delete(sessionId);
          res.writeHead(403, {"content-type": "application/json"});
          res.end(JSON.stringify({jsonrpc: "2.0", id: null, error: {code: INVALID_REQUEST, message: "Session expired."}}));
          return;
        }
        known.createdAt = Date.now();
      }

      const replies = [];
      for (const entry of Array.isArray(message) ? message : [message]) {
        const reply = await handle(entry);
        if (reply) replies.push(reply);
      }

      const headers = {"content-type": "application/json"};
      if (isInitialize) {
        sessions.set(sessionId, {createdAt: Date.now()});
        headers["mcp-session-id"] = sessionId;
      }

      if (replies.length === 0) {
        res.writeHead(202, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(Array.isArray(message) ? replies : replies[0]));
    });
  });

  await new Promise((resolve) => server.listen(port, "0.0.0.0", resolve));
  process.stderr.write(`mandate-mcp: listening on http://0.0.0.0:${port}/mcp\n`);
}

async function main() {
  if (!API_KEY) {
    process.stderr.write(
      "mandate-mcp: MANDATE_API_KEY is not set. The server needs one agent key from /api/agents/credentials.\n",
    );
    process.exit(2);
  }

  const transport = (process.env.MANDATE_MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "stdio") {
    // stdout is the protocol channel, so nothing else may write to it. Any stray console.log from an
    // imported module would corrupt the stream, hence the redirect.
    console.log = (...args) => process.stderr.write(`${args.join(" ")}\n`);
    await serveStdio();
    return;
  }
  if (transport === "http") {
    await serveHttp();
    return;
  }
  throw new Error(`Unknown MANDATE_MCP_TRANSPORT: ${transport}. Use "stdio" or "http".`);
}

main().catch((e) => {
  process.stderr.write(`mandate-mcp: ${e?.message ?? e}\n`);
  process.exit(1);
});
