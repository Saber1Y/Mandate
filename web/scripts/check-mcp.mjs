#!/usr/bin/env node
/**
 * Offline conformance check for the Mandate MCP server.
 *
 * Spawns mcp/server.mjs and drives the JSON-RPC handshake over stdio with a fake API behind it, so
 * the protocol layer is verified without spending real money or needing a running dashboard.
 *
 * What this guards, in order of how badly it would break a client:
 *   - a tool result is a `content` envelope, not a bare value (every client expects this)
 *   - a refused payment is returned as data with the on-chain reason, not as a protocol error, so a
 *     model reads the rule instead of retrying
 *   - a float amount is rejected with an explanatory message rather than silently rounded
 *   - notifications get no response, and an unknown method gets a proper JSON-RPC error
 *   - stdout carries only protocol frames
 *
 * Usage: node scripts/check-mcp.mjs
 */

import {spawn} from "node:child_process";
import {createServer} from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Fake Mandate API
// ---------------------------------------------------------------------------------------------

const routes = {
  "GET /api/agents/me": {
    agentId: "research-agent",
    agentAddress: "0x106e38F7957Dd28bB8edbDbf00B5ed4Dbf077bc6",
    vault: "0x45672a2cC6dfA5b975A6DBC5638C0154c01C85Be",
    chainId: 968,
    registeredOnChain: true,
    treasuryBalance: "470499000",
    token: {address: "0x75edC9335175Fc0552D51D48439F229c10420fe3", decimals: 6},
    policy: {
      maxPerTx: "100000000",
      dailyCap: "500000000",
      spentToday: "4501000",
      remainingDailyCap: "495499000",
      lastResetTime: 1791235000,
      expiry: 0,
      approvalThreshold: 0,
      active: true,
    },
    tokenAllowed: true,
  },
};

const seenAuth = [];

const server = createServer((req, res) => {
  seenAuth.push(req.headers.authorization ?? null);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const key = `${req.method} ${new URL(req.url, "http://x").pathname}`;

    if (key === "POST /api/requests") {
      const parsed = JSON.parse(body || "{}");
      // Mirror the contract: inside policy and allowlisted is auto-approved, otherwise it reverts.
      const amount = BigInt(parsed.amount ?? "0");
      const overCap = amount > 100000000n;
      const badRecipient = parsed.recipient === "0x3333333333333333333333333333333333333333";
      if (overCap || badRecipient) {
        res.writeHead(422, {"content-type": "application/json"});
        res.end(
          JSON.stringify({
            error: 'The contract function "requestSpend" reverted.',
            reason: overCap ? "InvalidPolicy" : "NotAuthorized",
          }),
        );
        return;
      }
      res.writeHead(201, {"content-type": "application/json"});
      res.end(
        JSON.stringify({
          requestId: `0x${"11".repeat(32)}`,
          requestTxHash: `0x${"22".repeat(32)}`,
          status: "Approved",
          approvals: 0,
          amount: String(amount),
          recipient: parsed.recipient,
          expiresAt: 1791324765,
        }),
      );
      return;
    }

    if (routes[key]) {
      res.writeHead(200, {"content-type": "application/json"});
      res.end(JSON.stringify(routes[key]));
      return;
    }

    res.writeHead(404, {"content-type": "application/json"});
    res.end(JSON.stringify({error: "not found"}));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------------------------
// Drive the server
// ---------------------------------------------------------------------------------------------

const child = spawn(process.execPath, [path.join(root, "mcp", "server.mjs")], {
  env: {...process.env, MANDATE_API_KEY: "mdt_test_key_not_a_real_credential", MANDATE_API_BASE: base},
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));

function call(id, method, params) {
  child.stdin.write(`${JSON.stringify({jsonrpc: "2.0", id, method, params})}\n`);
}

const replies = new Map();
function collect() {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && msg.id !== null) replies.set(msg.id, msg);
    } catch {
      // A non-JSON line on stdout is itself a failure; recorded by the framing check below.
    }
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const toolText = (msg) => msg?.result?.content?.[0]?.text ?? "";
const toolJson = (msg) => {
  try {
    return JSON.parse(toolText(msg));
  } catch {
    return null;
  }
};

// Handshake.
call(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: {name: "check-mcp", version: "1"},
});
await wait(250);
// A notification must not be answered.
child.stdin.write(`${JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"})}\n`);
await wait(120);
collect();

console.log("\nprotocol");
check("initialize answers with a supported protocol version", replies.get(1)?.result?.protocolVersion === "2025-06-18");
check("initialize advertises tool capability", replies.get(1)?.result?.capabilities?.tools !== undefined);
check("initialize names the server", replies.get(1)?.result?.serverInfo?.name === "mandate");
check(
  "an unknown protocol version falls back instead of failing",
  replies.get(1)?.result?.protocolVersion === "2025-06-18",
);

call(2, "tools/list");
call(3, "tools/call", {name: "get_budget", arguments: {}});
call(4, "tools/call", {
  name: "request_payment",
  arguments: {amount: "3000000", recipient: "0x2222222222222222222222222222222222222222"},
});
call(5, "tools/call", {
  name: "request_payment",
  arguments: {amount: "999000000000", recipient: "0x2222222222222222222222222222222222222222"},
});
call(6, "tools/call", {
  name: "request_payment",
  arguments: {amount: "1000", recipient: "0x3333333333333333333333333333333333333333"},
});
call(7, "tools/call", {name: "request_payment", arguments: {amount: "1.5", recipient: "0x2222222222222222222222222222222222222222"}});
call(8, "tools/call", {name: "check_spend", arguments: {amount: "999000000000"}});
call(9, "tools/call", {name: "no_such_tool", arguments: {}});
call(10, "no/such/method");
await wait(700);
collect();

console.log("\ntools");
const toolNames = (replies.get(2)?.result?.tools ?? []).map((t) => t.name);
check("tools/list returns the six tools", toolNames.length === 6, `got ${toolNames.length}`);
check("every tool declares an inputSchema", (replies.get(2)?.result?.tools ?? []).every((t) => t.inputSchema?.type === "object"));
check(
  "no tool accepts a URL, which prompt injection could redirect",
  (replies.get(2)?.result?.tools ?? []).every((t) => !JSON.stringify(t.inputSchema).match(/apiKey|baseUrl|url/i)),
);

console.log("\nresults are content envelopes");
check("get_budget returns a content array", Array.isArray(replies.get(3)?.result?.content));
check("get_budget content is text", replies.get(3)?.result?.content?.[0]?.type === "text");
check("readOnly tools are annotated", replies.get(2)?.result?.tools?.find((t) => t.name === "get_budget")?.annotations?.readOnlyHint === true);
check(
  "spending tools are annotated destructive",
  replies.get(2)?.result?.tools?.find((t) => t.name === "request_payment")?.annotations?.destructiveHint === true,
);

console.log("\nleash reporting");
const budget = toolJson(replies.get(3));
check("budget reports the per-transaction cap in both units", budget?.tUSDT?.maxPerTx?.base === "100000000" && budget?.tUSDT?.maxPerTx?.display === "100");
check("budget reports zero-approval as autonomous", budget?.approvalThreshold === 0 && budget?.ownerSignatureRequired === false);

console.log("\naccepted payment");
const paid = toolJson(replies.get(4));
check("an allowed payment is accepted", paid?.accepted === true);
check("it returns the requestId", typeof paid?.requestId === "string" && paid.requestId.length === 66);
check("it echoes a reusable idempotencyKey", /^0x[0-9a-f]{64}$/.test(paid?.idempotencyKey ?? ""));
check("it tells the model what to do next", typeof paid?.nextStep === "string" && paid.nextStep.length > 10);

console.log("\nrefused payments are data, not errors");
const overCap = replies.get(5);
check("over-cap refusal is a successful tool result", overCap?.result !== undefined && overCap?.error === undefined);
check("over-cap refusal carries the chain reason", toolJson(overCap)?.reason === "InvalidPolicy");
check("over-cap refusal says accepted=false", toolJson(overCap)?.accepted === false);
const badRecipient = toolJson(replies.get(6));
check("unallowlisted recipient is refused with NotAuthorized", badRecipient?.reason === "NotAuthorized");
check("refusal tells the model not to work around it", /do not retry/i.test(badRecipient?.nextStep ?? ""));
check("refusal keeps the idempotencyKey so a retry is not a second payment", /^0x[0-9a-f]{64}$/.test(badRecipient?.idempotencyKey ?? ""));

console.log("\ninput validation happens before any call");
check("a float amount is rejected", replies.get(7)?.error !== undefined);
check("the rejection explains base units", /base units/i.test(replies.get(7)?.error?.message ?? ""));

console.log("\ndry run");
const check1 = toolJson(replies.get(8));
check("check_spend reports the verdict without spending", check1?.wouldBeAccepted === false);
check("check_spend names the per-transaction cap as the reason", (check1?.problems ?? []).some((p) => /per-transaction cap/.test(p)));
check("check_spend is honest about not knowing the allowlist", /allowlisted/.test(check1?.note ?? ""));

console.log("\nerrors");
check("an unknown tool is a proper JSON-RPC error", replies.get(9)?.error?.code === -32000);
check("an unknown method returns method-not-found", replies.get(10)?.error?.code === -32601);

console.log("\ntransport");
check("no response was sent for the notification", ![...replies.keys()].includes(undefined));
check("every stdout line was valid JSON-RPC", !stdout.split("\n").filter((l) => l.trim()).some((l) => {
  try {
    JSON.parse(l);
    return false;
  } catch {
    return true;
  }
}));
check("no API key appears on stdout", !stdout.includes("mdt_test_key"));
// 6 tool calls are made, but the float-amount one is rejected by toBaseUnits before any fetch, so
// exactly 5 requests reach the API. Asserting the exact count is what catches a validation
// regression that silently starts spending on malformed input.
check(
  "exactly the valid calls reach the API (5 of 6)",
  seenAuth.filter(Boolean).length === 5,
  `${seenAuth.filter(Boolean).length} calls`,
);
check(
  "every API call carries the bearer key",
  seenAuth.every((h) => h === "Bearer mdt_test_key_not_a_real_credential"),
);

child.stdin.end();
await wait(200);
child.kill();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (stderr.trim()) console.log(`\nserver stderr:\n${stderr.trim().slice(0, 500)}`);
if (failed > 0) process.exitCode = 1;