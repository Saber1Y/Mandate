import {createWalletClient, createPublicClient, http, encodeFunctionData, parseAbi, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {ARC_RPC_URL, USDC_ADDRESS} from "./arc";

const VAULT_ABI = parseAbi([
  "function executeSpend(address token, address target, uint256 amount, bytes data, bytes32 actionId) returns (bool)",
  "function executeSpendFor(address agent, address token, address target, uint256 amount, bytes data, bytes32 actionId) returns (bool)",
  "function setAgentPolicy(address agent, uint128 maxPerTx, uint128 dailyCap, uint64 expiry, bool active)",
  "function setAllowedService(address agent, address target, string label, uint128 maxPerTx, uint128 dailyCap, uint64 expiry, bool allowed)",
  "function setAllowedToken(address agent, address token, bool allowed)",
  "function setExecutor(address executor, bool enabled)",
  "function deposit(uint256 amount)",
  "function owner() view returns (address)",
  "function usdc() view returns (address)",
  "function getPolicy(address agent) view returns ((uint128 maxPerTx,uint128 dailyCap,uint128 spentToday,uint64 lastResetTime,uint64 expiry,bool active))",
  "function remainingDailyCap(address agent) view returns (uint256)",
  "function getService(address agent,address target) view returns ((bool allowed,string label,uint128 maxPerTx,uint128 dailyCap,uint128 spentToday,uint64 lastResetTime,uint64 expiry))",
  "function allowedToken(address agent,address token) view returns (bool)",
]);

const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);

export interface ExecuteResult {
  success: boolean;
  txHash?: Hex;
  error?: string;
}

function getSigner(keyEnv: "EXECUTOR_PRIVATE_KEY" | "VAULT_OWNER_PRIVATE_KEY") {
  const key = process.env[keyEnv] as Hex | undefined;
  if (!key) throw new Error(`${keyEnv} not configured`);
  return privateKeyToAccount(key);
}

async function sendAndWait(to: Address, calldata: Hex): Promise<ExecuteResult> {
  try {
    const executor = getSigner("EXECUTOR_PRIVATE_KEY");
    const walletClient = createWalletClient({account: executor, transport: http(ARC_RPC_URL)});
    const publicClient = createPublicClient({transport: http(ARC_RPC_URL)});

    const txHash = await walletClient.sendTransaction({to, data: calldata, chain: undefined});
    const receipt = await publicClient.waitForTransactionReceipt({hash: txHash, timeout: 60_000});

    if (receipt.status === "reverted") {
      return {success: false, txHash, error: "Transaction reverted on-chain"};
    }
    return {success: true, txHash};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("reverted") || msg.includes("revert")) {
      return {success: false, error: `Vault rejected: ${msg.slice(0, 200)}`};
    }
    return {success: false, error: msg.slice(0, 200)};
  }
}

export async function checkVaultBalance(vaultAddress: Address): Promise<bigint> {
  const client = createPublicClient({transport: http(ARC_RPC_URL)});
  return client.readContract({address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [vaultAddress]});
}

/**
 * Verify an address is a SpendArc vault owned by `expectedOwner` with the canonical USDC
 * token. Used before binding a self-created per-user vault to a registered agent.
 */
export async function verifyUserVault(vaultAddress: Address, expectedOwner: Address): Promise<{ok: boolean; reason?: string}> {
  try {
    const client = createPublicClient({transport: http(ARC_RPC_URL)});
    const code = await client.getCode({address: vaultAddress});
    if (!code || code === "0x") return {ok: false, reason: "no contract at address"};
    const [owner, usdc] = await Promise.all([
      client.readContract({address: vaultAddress, abi: VAULT_ABI, functionName: "owner", args: []}),
      client.readContract({address: vaultAddress, abi: VAULT_ABI, functionName: "usdc", args: []}),
    ]);
    if ((owner as Address).toLowerCase() !== expectedOwner.toLowerCase()) return {ok: false, reason: "vault owner mismatch"};
    if ((usdc as Address).toLowerCase() !== USDC_ADDRESS.toLowerCase()) return {ok: false, reason: "vault does not use canonical USDC"};
    return {ok: true};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {ok: false, reason: msg.slice(0, 200)};
  }
}

/**
 * Server-side testnet faucet: send native gas + USDC from the operator key to a visitor
 * wallet so it can create its own vault and deposit. Owner key must hold both assets.
 */
export async function fundVisitorWallet(to: Address, gasEthWei: bigint, usdcBaseUnits: bigint) {
  const owner = getSigner("VAULT_OWNER_PRIVATE_KEY");
  const walletClient = createWalletClient({account: owner, transport: http(ARC_RPC_URL)});
  const publicClient = createPublicClient({transport: http(ARC_RPC_URL)});
  try {
    const gasTx = await walletClient.sendTransaction({to, value: gasEthWei, chain: undefined});
    await publicClient.waitForTransactionReceipt({hash: gasTx, timeout: 60_000});
    const usdcTx = await walletClient.sendTransaction({
      to: USDC_ADDRESS,
      data: encodeFunctionData({abi: USDC_ABI, functionName: "transfer", args: [to, usdcBaseUnits]}),
      chain: undefined,
    });
    await publicClient.waitForTransactionReceipt({hash: usdcTx, timeout: 60_000});
    return {success: true as const, gasTx, usdcTx};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {success: false as const, error: msg.slice(0, 200)};
  }
}

export async function getVaultPolicy(vaultAddress: Address, agentAddress: Address) {
  const client = createPublicClient({transport: http(ARC_RPC_URL)});
  const [policy, remaining] = await Promise.all([
    client.readContract({address: vaultAddress, abi: VAULT_ABI, functionName: "getPolicy", args: [agentAddress]}),
    client.readContract({address: vaultAddress, abi: VAULT_ABI, functionName: "remainingDailyCap", args: [agentAddress]}),
  ]);
  return {policy, remainingDailyCap: remaining as bigint};
}

export interface VaultService {
  allowed: boolean;
  label: string;
  maxPerTx: bigint;
  dailyCap: bigint;
  spentToday: bigint;
  lastResetTime: bigint;
  expiry: bigint;
}

export async function checkVaultAllowlist(vaultAddress: Address, agentAddress: Address, target: Address, token: Address) {
  const client = createPublicClient({transport: http(ARC_RPC_URL)});
  const [targetPolicy, tokenOk] = await Promise.all([
    client.readContract({address: vaultAddress, abi: VAULT_ABI, functionName: "getService", args: [agentAddress, target]}),
    client.readContract({address: vaultAddress, abi: VAULT_ABI, functionName: "allowedToken", args: [agentAddress, token]}),
  ]);
  return {targetAllowed: (targetPolicy as VaultService).allowed, tokenAllowed: tokenOk as boolean, service: targetPolicy as VaultService};
}

/** Read the on-chain `serviceAllowlist` policy for `agent` paying `target`. Used to verify a visitor-signed allowlist change before mirroring to the DB. */
export async function getVaultService(vaultAddress: Address, agentAddress: Address, target: Address): Promise<VaultService> {
  const client = createPublicClient({transport: http(ARC_RPC_URL)});
  return client.readContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "getService",
    args: [agentAddress, target],
  }) as Promise<VaultService>;
}

/**
 * Execute a spend on behalf of `agent`. The vault enforces the AGENT's policy,
 * not the executor's. The executor (server key) must be an authorized executor
 * (or the owner) in the vault.
 */
export async function executeVaultSpend(
  vaultAddress: Address,
  agent: Address,
  token: Address,
  recipient: Address,
  amount: bigint,
  actionId: Hex,
): Promise<ExecuteResult> {
  const calldata = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: "executeSpendFor",
    args: [agent, token, recipient, amount, "0x" as Hex, actionId],
  });
  return sendAndWait(vaultAddress, calldata);
}

/**
 * Owner-only on-chain policy update: adjust an agent's maxPerTx/dailyCap.
 * The server holds the owner key, so visitor self-service can update the
 * vault-enforced leash without the visitor signing anything.
 */
export async function setAgentPolicyOnChain(vaultAddress: Address, agent: Address, maxPerTx: bigint, dailyCap: bigint, expiry = 0n, active = true): Promise<ExecuteResult> {
  const owner = getSigner("VAULT_OWNER_PRIVATE_KEY");
  const walletClient = createWalletClient({account: owner, transport: http(ARC_RPC_URL)});
  const publicClient = createPublicClient({transport: http(ARC_RPC_URL)});

  const calldata = encodeFunctionData({abi: VAULT_ABI, functionName: "setAgentPolicy", args: [agent, maxPerTx, dailyCap, expiry, active]});
  try {
    const txHash = await walletClient.sendTransaction({to: vaultAddress, data: calldata, chain: undefined});
    const receipt = await publicClient.waitForTransactionReceipt({hash: txHash, timeout: 60_000});
    if (receipt.status !== "success") {
      return {success: false, txHash, error: "setAgentPolicy reverted on-chain"};
    }
    return {success: true, txHash};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("reverted") || msg.includes("revert")) {
      return {success: false, error: `Vault rejected: ${msg.slice(0, 200)}`};
    }
    return {success: false, error: msg.slice(0, 200)};
  }
}

/** Owner-only on-chain registration: create/set an agent's policy + allowlists (self-target as a service). */
export async function registerAgentOnChain(vaultAddress: Address, agent: Address, maxPerTx: bigint, dailyCap: bigint, token: Address, target: Address, label = "self") {
  const owner = getSigner("VAULT_OWNER_PRIVATE_KEY");
  const walletClient = createWalletClient({account: owner, transport: http(ARC_RPC_URL)});
  const publicClient = createPublicClient({transport: http(ARC_RPC_URL)});

  const txHashes: Hex[] = [];

  const setPolicy = encodeFunctionData({abi: VAULT_ABI, functionName: "setAgentPolicy", args: [agent, maxPerTx, dailyCap, 0n, true]});
  const tx = await walletClient.sendTransaction({to: vaultAddress, data: setPolicy, chain: undefined});
  const policyReceipt = await publicClient.waitForTransactionReceipt({hash: tx, timeout: 60_000});
  if (policyReceipt.status !== "success") return {success: false as const, txHash: tx, error: "setAgentPolicy reverted on-chain"};
  txHashes.push(tx);

  const setToken = encodeFunctionData({abi: VAULT_ABI, functionName: "setAllowedToken", args: [agent, token, true]});
  const tx2 = await walletClient.sendTransaction({to: vaultAddress, data: setToken, chain: undefined});
  const tokenReceipt = await publicClient.waitForTransactionReceipt({hash: tx2, timeout: 60_000});
  if (tokenReceipt.status !== "success") return {success: false as const, txHash: tx2, error: "setAllowedToken reverted on-chain"};
  txHashes.push(tx2);

  const setTarget = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: "setAllowedService",
    args: [agent, target, label, 0n, 0n, 0n, true],
  });
  const tx3 = await walletClient.sendTransaction({to: vaultAddress, data: setTarget, chain: undefined});
  const targetReceipt = await publicClient.waitForTransactionReceipt({hash: tx3, timeout: 60_000});
  if (targetReceipt.status !== "success") return {success: false as const, txHash: tx3, error: "setAllowedService reverted on-chain"};
  txHashes.push(tx3);

  return {success: true as const, txHashes};
}
