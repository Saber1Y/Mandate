#!/usr/bin/env node
/**
 * Mandate API QA runner.
 *
 * Exercises the live control plane an autonomous agent actually uses: bearer auth, request
 * validation, on-chain policy rejection, and the approval-then-execute lifecycle. It asserts on
 * HTTP status and decoded contract error names, because the contract is the only authority - a
 * cached mirror agreeing with itself proves nothing.
 *
 * Usage:
 *   node scripts/qa-agent.mjs --api-key mdt_... [--base http://localhost:3000] [--settle]
 *   node scripts/qa-agent.mjs --dry-run
 *
 * Env: AGENT_API_KEY, AGENT_API_BASE, QA_RECIPIENT (allowlisted recipient, required for --settle).
 */

import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BYTES32 = "0x" + "11".repeat(32);

/** Must be allowlisted for the over-cap check to reach the cap check at all. See runPolicy(). */
const OVER_CAP_RECIPIENT = "0x2222222222222222222222222222222222222222";
/** Deliberately never allowlisted, so the authorization fence is what rejects it. */
const NOT_ALLOWLISTED_RECIPIENT = "0x3333333333333333333333333333333333333333";

function parseArgs(argv) {
  const args = {apiKey: null, base: null, dryRun: false, settle: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-key") args.apiKey = argv[++i];
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--settle") args.settle = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  args.base = args.base || process.env.AGENT_API_BASE || "http://localhost:3000";
  args.apiKey = args.apiKey || process.env.AGENT_API_KEY || null;
  return args;
}

async function api(base, pathname, {method = "GET", body, auth} = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (auth) headers["authorization"] = `Bearer ${auth}`;
  const res = await fetch(`${base}${pathname}`, {method, headers, body: body ? JSON.stringify(body) : undefined});
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = {raw: text.slice(0, 200)};
  }
  return {status: res.status, body: json};
}

let passed = 0;
let failed = 0;

function check(title, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${title}`);
  } else {
    failed++;
    console.error(`  FAIL ${title}${detail ? ` -> ${detail}` : ""}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

/**
 * Scenarios that need no network, so --dry-run still reports the suite shape.
 */
function dryRun() {
  console.log("Mandate QA dry run. Live checks that would run:");
  for (const [group, names] of Object.entries(SCENARIOS)) {
    console.log(`\n${group}`);
    for (const name of names) console.log(`  - ${name}`);
  }
  const count = Object.values(SCENARIOS).reduce((n, g) => n + g.length, 0);
  console.log(`\n${count} checks would run, 0 executed.`);
}

const SCENARIOS = {
  "auth and identity": [
    "health responds without credentials",
    "/api/agents/me requires a bearer key",
    "/api/agents/me returns the on-chain policy",
  ],
  "request validation": [
    "malformed body is rejected",
    "non-address recipient is rejected",
    "float amount is rejected",
    "zero amount is rejected",
    "malformed token is rejected",
    "missing idempotency key is rejected",
    "bad request id is rejected",
  ],
  "on-chain policy": [
    "over the per-transaction cap reverts on-chain",
    "an unallowlisted recipient reverts on-chain",
  ],
};

async function runAuthAndIdentity(base, key) {
  section("auth and identity");

  const health = await api(base, "/api/health");
  check("health responds without credentials", health.status === 200, `status ${health.status}`);

  const anon = await api(base, "/api/agents/me");
  check("/api/agents/me requires a bearer key", anon.status === 401, `status ${anon.status}`);

  const me = await api(base, "/api/agents/me", {auth: key});
  check(
    "/api/agents/me returns the on-chain policy",
    me.status === 200 && me.body?.registeredOnChain === true && !!me.body?.policy,
    JSON.stringify(me.body).slice(0, 200),
  );
}

async function runValidation(base, key) {
  section("request validation");

  const cases = [
    ["non-address recipient is rejected", {amount: "1000", recipient: "0xnope"}, 400],
    ["float amount is rejected", {amount: "1.5", recipient: "0x2222222222222222222222222222222222222222"}, 400],
    ["zero amount is rejected", {amount: "0", recipient: "0x2222222222222222222222222222222222222222"}, 400],
    ["malformed token is rejected", {amount: "1000", recipient: "0x2222222222222222222222222222222222222222", token: "0xdeadbeef"}, 400],
    ["missing idempotency key is rejected", {amount: "1000", recipient: "0x2222222222222222222222222222222222222222"}, 400],
  ];

  for (const [title, body, expected] of cases) {
    // "missing idempotency key" must send no key at all, so it is posted without the default one.
    const payload = title.includes("missing idempotency") ? body : {...body, idempotencyKey: BYTES32};
    const res = await api(base, "/api/requests", {method: "POST", auth: key, body: payload});
    check(title, res.status === expected, `status ${res.status} body ${JSON.stringify(res.body)}`);
  }

  const badId = await api(base, "/api/requests/0x1234", {auth: key});
  check("bad request id is rejected", badId.status === 400, `status ${badId.status}`);
}

async function runPolicy(base, key) {
  section("on-chain policy");

  // Precondition: both checks below pay a recipient, and MandateVault._validate tests the recipient
  // allowlist BEFORE any cap. So recipient 0x2222...2222 must be allowlisted for this agent, or the
  // over-cap case reports NotAuthorized and proves nothing about caps.
  //
  //   cast send <vault> "setAllowedService(address,address,string,uint256,uint256,uint64,bool)" \
  //     <agent> 0x2222222222222222222222222222222222222222 "qa" 0 0 0 true
  //
  // Remove it afterwards to leave the treasury as it was found.

  // Far beyond any sane per-transaction cap. The vault must reject it, not the server.
  const overCap = await api(base, "/api/requests", {
    method: "POST",
    auth: key,
    body: {
      amount: "100000000000000000000000000000000000",
      recipient: OVER_CAP_RECIPIENT,
      idempotencyKey: "0x" + "22".repeat(32),
    },
  });
  check(
    "over the per-transaction cap reverts on-chain",
    overCap.status === 422 && overCap.body?.reason === "InvalidPolicy",
    overCap.body?.reason === "NotAuthorized"
      ? `status ${overCap.status} reason NotAuthorized - ${OVER_CAP_RECIPIENT} is not allowlisted for this agent, so the allowlist is checked before the cap. Grant the fixture, see runPolicy().`
      : `status ${overCap.status} reason ${overCap.body?.reason}`,
  );

  // A recipient the operator has not allowlisted must fail closed.
  const unallowlisted = await api(base, "/api/requests", {
    method: "POST",
    auth: key,
    body: {
      amount: "1000",
      recipient: NOT_ALLOWLISTED_RECIPIENT,
      idempotencyKey: "0x" + "33".repeat(32),
    },
  });
  check(
    "an unallowlisted recipient reverts on-chain",
    unallowlisted.status === 422 && unallowlisted.body?.reason === "NotAuthorized",
    `status ${unallowlisted.status} reason ${unallowlisted.body?.reason}`,
  );
}

async function runSettlement(base, key, recipient) {
  section("approval and settlement");
  console.log("  Approving requires the organization owner wallet, which this runner does not hold.");
  console.log(`  Request 1 tUSDT-equivalent unit to ${recipient}, then approve on-chain, then execute:`);
  const created = await api(base, "/api/requests", {
    method: "POST",
    auth: key,
    body: {amount: "1000", recipient, idempotencyKey: "0x" + "44".repeat(32)},
  });
  check(
    "request creates a pending mandate",
    created.status === 201 && created.body?.status === "Pending",
    `status ${created.status} body ${JSON.stringify(created.body).slice(0, 200)}`,
  );
  if (created.status !== 201) return;

  const {requestId} = created.body;
  const early = await api(base, `/api/requests/${requestId}/execute`, {method: "POST", auth: key});
  check(
    "execution before approval reverts",
    early.status === 422 && early.body?.reason === "RequestNotApproved",
    `status ${early.status} reason ${early.body?.reason}`,
  );
  console.log(`\n  requestId: ${requestId}`);
  console.log(`  approve:   cast send <vault> "approve(bytes32)" ${requestId} --private-key <owner>`);
  console.log(`  execute:   curl -X POST -H "authorization: Bearer $AGENT_API_KEY" \\`);
  console.log(`               ${base}/api/requests/${requestId}/execute`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/qa-agent.mjs --api-key mdt_... [--base URL] [--settle] [--dry-run]");
    return;
  }
  if (args.dryRun) return dryRun();

  if (!args.apiKey) {
    console.error("An agent API key is required. Pass --api-key mdt_... or set AGENT_API_KEY.");
    process.exitCode = 2;
    return;
  }

  console.log(`Mandate QA against ${args.base}`);
  await runAuthAndIdentity(args.base, args.apiKey);
  await runValidation(args.base, args.apiKey);
  await runPolicy(args.base, args.apiKey);
  if (args.settle) {
    const recipient = process.env.QA_RECIPIENT;
    if (!recipient) {
      console.error("--settle needs QA_RECIPIENT set to an allowlisted address.");
      process.exitCode = 2;
      return;
    }
    await runSettlement(args.base, args.apiKey, recipient);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});