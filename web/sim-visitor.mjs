import {privateKeyToAccount} from "viem/accounts";
import {createWalletClient, createPublicClient, http, parseAbi, encodeFunctionData} from "viem";
import {readFileSync, writeFileSync} from "fs";

const RPC = "https://rpc.testnet.arc.network";
const USDC = "0x3600000000000000000000000000000000000000";
const FACTORY = "0x084c2061384bffd6254d1423e35b53ea91aaed87";
const BASE = "http://localhost:3000";

const factoryAbi = parseAbi([
  "function createVault(uint128 maxPerTx,uint128 dailyCap,uint64 expiry) returns (address)",
  "function vaultOf(address owner) view returns (address)",
]);
const usdcAbi = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);
const vaultAbi = parseAbi([
  "function deposit(uint256 amount)",
  "function withdrawTokens(address token,address to,uint256 amount)",
  "function getPolicy(address agent) view returns ((uint128 maxPerTx,uint128 dailyCap,uint128 spentToday,uint64 lastResetTime,uint64 expiry,bool active))",
  "function getService(address agent,address target) view returns ((bool allowed,string label,uint128 maxPerTx,uint128 dailyCap,uint128 spentToday,uint64 lastResetTime,uint64 expiry))",
]);

const OPERATOR = "0x3F5b96A494061F7338Da529e3047809Ac6a7FB84";
const publicClient = createPublicClient({transport: http(RPC)});

const KEYFILE = "/tmp/sim-visitor-key.txt";

// Fresh key each run: the factory allows one vault per owner, so a persisted
// visitor blocks repeat runs. The key is written to KEYFILE (and printed) so
// stranded funds can be recovered manually if the run fails mid-flight.
function loadOrGenKey() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  const k = "0x" + Buffer.from(b).toString("hex");
  writeFileSync(KEYFILE, k);
  return k;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTx(account, to, data, label) {
  // Arc's RPC rate-limits raw tx submission; throttle so burst runs survive.
  await sleep(1200);
  const wallet = createWalletClient({account, transport: http(RPC)});
  const hash = await wallet.sendTransaction({to, data, chain: null});
  console.log(`  [${label}] tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({hash, timeout: 90_000});
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  return hash;
}

async function recover(account, vault, visitor) {
  try {
    const vaultBalance = await publicClient.readContract({address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [vault]});
    if (vaultBalance > 0n) {
      await sendTx(account, vault, encodeFunctionData({abi: vaultAbi, functionName: "withdrawTokens", args: [USDC, visitor, vaultBalance]}), "withdraw");
    }
    const visitorBalance = await publicClient.readContract({address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [visitor]});
    // Arc pays gas from the same balance, so the full-balance transfer fails
    // estimation. Leave ~0.4 USDC as a gas buffer (observed failures below ~0.16).
    if (visitorBalance > 450_000n) {
      const amt = visitorBalance - 400_000n;
      await sendTx(account, USDC, encodeFunctionData({abi: usdcAbi, functionName: "transfer", args: [OPERATOR, amt]}), "returnFunds");
      console.log("recovery: returned", amt.toString(), "USDC to operator");
    }
  } catch (e) {
    console.log("recovery skipped (best-effort):", e.message.slice(0, 120));
  }
}

async function main() {
  const key = loadOrGenKey();
  const account = privateKeyToAccount(key);
  const visitor = account.address;
  console.log("visitor:", visitor);
  console.log("key:", key);

  // 1. Faucet
  const fund = await (await fetch(`${BASE}/api/fund`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({address: visitor}),
  })).json();
  console.log("fund:", fund.success === undefined ? fund : fund);
  if (!fund.usdcTx) throw new Error("faucet failed");

  const walletUsdc = await publicClient.readContract({address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [visitor]});
  console.log("wallet USDC after fund:", walletUsdc.toString());

  let vault = "0x0000000000000000000000000000000000000000";
  try {
  // 2. Create vault
  await sendTx(account, FACTORY, encodeFunctionData({abi: factoryAbi, functionName: "createVault", args: [5_000_000n, 10_000_000n, 0n]}), "createVault");
  vault = await publicClient.readContract({address: FACTORY, abi: factoryAbi, functionName: "vaultOf", args: [visitor]});
  console.log("vault:", vault);

  // 3. Approve + deposit
  const DEPOSIT = 3_000_000n;
  await sendTx(account, USDC, encodeFunctionData({abi: usdcAbi, functionName: "approve", args: [vault, DEPOSIT]}), "approve");
  await sendTx(account, vault, encodeFunctionData({abi: vaultAbi, functionName: "deposit", args: [DEPOSIT]}), "deposit");
  const vb = await publicClient.readContract({address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [vault]});
  console.log("vault USDC after deposit:", vb.toString());

  // 4. Register agent
  const reg = await (await fetch(`${BASE}/api/agents/user`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({name: "Sim Visitor", address: visitor, vaultAddress: vault}),
  })).json();
  if (!reg.apiKey) { console.error("register failed:", reg); throw new Error("register failed"); }
  console.log("registered:", reg.agent.id, "vaultAddress:", reg.vaultAddress);
  const apiKey = reg.apiKey;
  const agentId = reg.agent.id;

  // 5. Introspect leash
  const me = await (await fetch(`${BASE}/api/agents/me`, {headers: {authorization: `Bearer ${apiKey}`}})).json();
  console.log("introspect:", JSON.stringify(me.agent ?? me).slice(0, 300));

  // 6. Payment 0.5
  const pay = await (await fetch(`${BASE}/api/payments/request`, {
    method: "POST",
    headers: {"content-type": "application/json", authorization: `Bearer ${apiKey}`},
    body: JSON.stringify({agentId, recipient: visitor, amount: "0.5", token: "USDC", purpose: "sim test"}),
  })).json();
  console.log("payment(0.5):", JSON.stringify(pay).slice(0, 400));

  // 6b. Allowlist a third-party service (fresh account, not the visitor) and pay it.
  const svc = privateKeyToAccount(loadOrGenKey());
  console.log("service:", svc.address);
  const al = await (await fetch(`${BASE}/api/allowlist/${agentId}/update`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({address: svc.address, allowed: true, label: "Sim Analytics API"}),
  })).json();
  console.log("allowlist update has tx:", !!al.tx, al.tx ? al.tx.description : al);
  if (!al.tx || al.tx.to === "0x0000000000000000000000000000000000000000") throw new Error("no calldata from allowlist update");
  await sendTx(account, al.tx.to, al.tx.data, "signServiceAllowlist");
  const alSync = await (await fetch(`${BASE}/api/allowlist/${agentId}/sync`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({address: svc.address, allowed: true, label: "Sim Analytics API"}),
  })).json();
  console.log("allowlist sync:", JSON.stringify(alSync).slice(0, 200));
  const onchainService = await publicClient.readContract({
    address: vault, abi: vaultAbi, functionName: "getService", args: [visitor, svc.address],
  });
  const onchainAllowed = onchainService.allowed;
  console.log("on-chain service(agent, service):", {allowed: onchainAllowed, label: onchainService.label, maxPerTx: onchainService.maxPerTx.toString(), dailyCap: onchainService.dailyCap.toString()});
  const dbList = await (await fetch(`${BASE}/api/allowlist/${agentId}`, {headers: {authorization: `Bearer ${apiKey}`}})).json();
  console.log("server allowlist recipients:", JSON.stringify(dbList.recipients ?? dbList).slice(0, 300));
  if (!onchainAllowed) throw new Error("service not allowlisted on-chain");
  const svcPay = await (await fetch(`${BASE}/api/payments/request`, {
    method: "POST",
    headers: {"content-type": "application/json", authorization: `Bearer ${apiKey}`},
    body: JSON.stringify({agentId, recipient: svc.address, amount: "0.05", token: "USDC", purpose: "pay service"}),
  })).json();
  console.log("payment(0.05 to service):", JSON.stringify(svcPay).slice(0, 400));
  const svcBal = await publicClient.readContract({address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [svc.address]});
  console.log("service USDC balance:", svcBal.toString());

  // 7. Leash edit: lower cap to 0.1/1
  const upd = await (await fetch(`${BASE}/api/policies/${agentId}/update`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({maxPerTxUsdc: 0.1, dailyCapUsdc: 1}),
  })).json();
  console.log("update response has tx:", !!upd.tx, upd.tx ? upd.tx.description : upd);
  if (!upd.tx || upd.tx.to === "0x0000000000000000000000000000000000000000") throw new Error("no calldata from update");

  await sendTx(account, upd.tx.to, upd.tx.data, "signLeashUpdate");
  const sync = await (await fetch(`${BASE}/api/policies/${agentId}/sync`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({maxPerTxUsdc: 0.1, dailyCapUsdc: 1}),
  })).json();
  console.log("sync:", JSON.stringify(sync).slice(0, 200));

  // 8. Overspend: 0.5 > 0.1 cap -> blocked
  const over = await (await fetch(`${BASE}/api/payments/request`, {
    method: "POST",
    headers: {"content-type": "application/json", authorization: `Bearer ${apiKey}`},
    body: JSON.stringify({agentId, recipient: visitor, amount: "0.5", token: "USDC", purpose: "overspend sim"}),
  })).json();
  console.log("payment(0.5 after cap 0.1):", JSON.stringify(over).slice(0, 400));

  // 9. Best-effort recovery: withdraw vault USDC back to visitor, then return all visitor
  //    USDC to the operator so repeated test runs do not drain the demo faucet.
  await recover(account, vault, visitor);

  console.log("\nDONE");
  } catch (e) {
    console.log("recovering after failure...");
    await recover(account, vault, visitor);
    throw e;
  }
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
