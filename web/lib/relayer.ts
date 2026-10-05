import {createPublicClient, createWalletClient, http, type Address, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {botChain} from "./bot";
import {mandateVaultAbi} from "./abi/mandate";

/**
 * Gas-only relayer.
 *
 * This module can submit exactly two things: `requestSpend` for an already-authenticated agent,
 * and `execute` for a request that is already Approved on-chain. It holds no owner authority.
 *
 * It deliberately does NOT expose policy writes, allowlist writes, agent registration, executor
 * management, approvals, or withdrawals. Those are owner-only in MandateVault and are signed by
 * the organization's own wallet in the browser. That separation is the product: the platform pays
 * gas and nothing else.
 *
 * The contract is the authority. Every function here forwards a request and then reports what the
 * chain decided. Nothing is pre-approved, pre-capped, or pre-allowed on this side.
 */

export interface RelayerResult {
  success: boolean;
  txHash?: Hex;
  error?: string;
  /** Custom error name decoded from the contract, when the revert came from MandateVault. */
  reason?: string;
}

export class MissingExecutorKeyError extends Error {
  constructor() {
    super(
      "EXECUTOR_PRIVATE_KEY is not configured. The relayer needs a gas-only key that is " +
        "registered with setExecutor() on the vault. It must never be the owner key.",
    );
    this.name = "MissingExecutorKeyError";
  }
}

function executorAccount() {
  const key = process.env.EXECUTOR_PRIVATE_KEY as Hex | undefined;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new MissingExecutorKeyError();
  return privateKeyToAccount(key);
}

const rpc = () => botChain.rpcUrls.default.http[0];
const publicClient = () => createPublicClient({chain: botChain, transport: http(rpc())});

/**
 * Pull the custom-error name out of a viem revert so callers can react to a specific rule
 * (NotRegistered, InvalidPolicy, InsufficientBalance, ...) instead of parsing prose.
 */
function decodeRevertReason(error: unknown): string | undefined {
  const err = error as {
    contractFunctionName?: string;
    shortMessage?: string;
    message?: string;
    data?: {errorName?: string};
    cause?: {data?: {errorName?: string}};
  };
  const name =
    err?.data?.errorName ?? err?.cause?.data?.errorName ?? undefined;
  if (name) return name;
  const msg = err?.shortMessage ?? err?.message ?? "";
  const match = msg.match(/\b([A-Z][A-Za-z0-9]+)\(/);
  return match?.[1];
}

async function submit(
  fn: (client: ReturnType<typeof wallet>) => Promise<Hex>,
): Promise<RelayerResult> {
  try {
    const txHash = await fn(wallet());
    const receipt = await publicClient().waitForTransactionReceipt({hash: txHash, timeout: 90_000});
    if (receipt.status === "reverted") {
      return {success: false, txHash, error: "Transaction reverted on-chain"};
    }
    return {success: true, txHash};
  } catch (e) {
    return {success: false, error: truncate(e), reason: decodeRevertReason(e)};
  }
}

function truncate(e: unknown): string {
  const err = e as {shortMessage?: string; message?: string};
  return (err?.shortMessage ?? err?.message ?? String(e)).slice(0, 300);
}

function wallet() {
  return createWalletClient({account: executorAccount(), chain: botChain, transport: http(rpc())});
}

/**
 * Submit a spend request for `agent`.
 *
 * The executor is allowed to relay this (MandateVault._request permits executors), but the vault
 * validates the AGENT's policy, not the relayer's: caps, expiry, token allowlist, recipient
 * allowlist and balance are all checked on-chain against `agent`. A request that breaks policy
 * reverts here and never reaches an approver.
 */
export async function relayRequestSpend(params: {
  vault: Address;
  agent: Address;
  token: Address;
  recipient: Address;
  amount: bigint;
  idempotencyKey: Hex;
  expiresAt?: bigint;
}): Promise<RelayerResult> {
  const {vault} = params;
  return submit(async (client) =>
    client.writeContract({
      address: vault,
      chain: botChain,
      abi: mandateVaultAbi,
      functionName: "requestSpend",
      args: [
        params.agent,
        params.token,
        params.recipient,
        params.amount,
        params.idempotencyKey,
        params.expiresAt ?? 0n,
      ],
    }),
  );
}

/**
 * Settle an Approved request. `_execute` re-validates the entire policy at settlement time, so a
 * request approved earlier still reverts if the balance dropped or the policy tightened since.
 */
export async function relayExecute(vault: Address, requestId: Hex): Promise<RelayerResult> {
  return submit(async (client) =>
    client.writeContract({
      address: vault,
      chain: botChain,
      abi: mandateVaultAbi,
      functionName: "execute",
      args: [requestId],
    }),
  );
}

/** Read the request back from the chain. Returns null when the id is unknown. */
export async function readRequest(vault: Address, requestId: Hex) {
  try {
    const request = await publicClient().readContract({
      address: vault,
      abi: mandateVaultAbi,
      functionName: "getRequest",
      args: [requestId],
    });
    return request as MandateRequest;
  } catch {
    return null;
  }
}

/**
 * MandateVault.getRequest returns exactly these fields. Note there is no `executedAt`: settlement
 * time is the `RequestExecuted` event, so do not invent the field here.
 */
export interface MandateRequest {
  agent: Address;
  token: Address;
  target: Address;
  amount: bigint;
  requestedAt: bigint;
  expiresAt: bigint;
  approvals: number;
  status: number;
}

/** Throw when the configured executor is not registered on the vault, with the fix spelled out. */
export async function assertExecutorRegistered(vault: Address): Promise<void> {
  const account = executorAccount();
  const ok = await publicClient().readContract({
    address: vault,
    abi: mandateVaultAbi,
    functionName: "executors",
    args: [account.address],
  });
  if (!ok) {
    throw new Error(
      `Relayer ${account.address} is not a registered executor on vault ${vault}. ` +
        `The vault owner must call setExecutor(${account.address}, true).`,
    );
  }
}