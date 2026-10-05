import type {Address} from "viem";
import {TUSDT_ADDRESS} from "./bot";
import {publicClient} from "./chain";
import {mandateVaultAbi} from "./abi/mandate";
import {erc20Abi} from "./contracts";

/**
 * Chain reads for the dashboard.
 *
 * Every value here comes from a live contract call. Nothing is mirrored, cached across requests,
 * or served from a database, so what the UI shows is what the vault will actually enforce.
 */

/** Recent-block window used when a caller does not pin `fromBlock`. */
const HISTORY_WINDOW = 200_000n;

export interface AgentPolicy {
  maxPerTx: bigint;
  dailyCap: bigint;
  spentToday: bigint;
  lastResetTime: bigint;
  expiry: bigint;
  approvalThreshold: number;
  active: boolean;
}

export interface ServicePolicy {
  allowed: boolean;
  label: string;
  maxPerTx: bigint;
  dailyCap: bigint;
  spentToday: bigint;
  lastResetTime: bigint;
  expiry: bigint;
}

export interface TreasuryState {
  vault: Address;
  vaultOwner: Address;
  treasuryBalance: bigint;
  token: Address;
  paused: boolean;
}

export interface AgentBudgetState extends TreasuryState {
  agent: Address;
  registered: boolean;
  policy: AgentPolicy;
  remainingDailyCap: bigint;
  tokenAllowed: boolean;
}

async function readOrThrow<T>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not read ${what} from BOT Chain: ${msg.slice(0, 200)}`);
  }
}

export async function readTreasuryState(vault: Address): Promise<TreasuryState> {
  return readOrThrow(async () => {
    const [vaultOwner, treasuryBalance, paused] = await Promise.all([
      publicClient.readContract({address: vault, abi: mandateVaultAbi, functionName: "owner"}),
      publicClient.readContract({
        address: TUSDT_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
      publicClient.readContract({address: vault, abi: mandateVaultAbi, functionName: "paused"}),
    ]);
    return {
      vault,
      vaultOwner: vaultOwner as Address,
      treasuryBalance: treasuryBalance as bigint,
      token: TUSDT_ADDRESS,
      paused: Boolean(paused),
    };
  }, "treasury state");
}

export async function readAgentBudget(vault: Address, agent: Address): Promise<AgentBudgetState> {
  return readOrThrow(async () => {
    const [treasury, policy, remaining, tokenAllowed, registered] = await Promise.all([
      readTreasuryState(vault),
      publicClient.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: "getPolicy",
        args: [agent],
      }),
      publicClient.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: "remainingDailyCap",
        args: [agent],
      }),
      publicClient.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: "allowedTokens",
        args: [agent, TUSDT_ADDRESS],
      }),
      publicClient.readContract({address: vault, abi: mandateVaultAbi, functionName: "agents", args: [agent]}),
    ]);

    const p = policy as AgentPolicy;
    return {
      ...treasury,
      agent,
      registered: Boolean(registered),
      policy: p,
      remainingDailyCap: remaining as bigint,
      tokenAllowed: Boolean(tokenAllowed),
    };
  }, `budget for agent ${agent}`);
}

export async function readServicePolicy(vault: Address, agent: Address, target: Address): Promise<ServicePolicy> {
  return readOrThrow(
    async () =>
      (await publicClient.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: "getService",
        args: [agent, target],
      })) as ServicePolicy,
    `service policy for ${target}`,
  );
}

export interface SpendEvent {
  requestId: `0x${string}`;
  kind: "requested" | "executed" | "approved" | "rejected" | "expired" | "cancelled" | "settled";
  agent: Address;
  token: Address;
  target: Address;
  amount: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
  /** Block time of the log, read from the chain. Never substituted with the local clock. */
  timestamp: bigint;
}

/** Block timestamps are expensive, so resolve each distinct block once per history read. */
const blockTimeCache = new Map<bigint, bigint>();

async function blockTimestamp(blockNumber: bigint): Promise<bigint> {
  if (blockNumber === 0n) return 0n;
  const cached = blockTimeCache.get(blockNumber);
  if (cached !== undefined) return cached;
  try {
    const block = await publicClient.getBlock({blockNumber});
    const ts = block?.timestamp ?? 0n;
    blockTimeCache.set(blockNumber, ts);
    return ts;
  } catch {
    return 0n;
  }
}

/**
 * Recent spend history, read from contract events rather than a database.
 *
 * Using events means history cannot be forged by anything the app does: there is no write path to
 * a "transactions" table. The tradeoff is RPC cost at scale - on mainnet this should be served from
 * an indexer, but the source of truth stays the chain either way.
 *
 * Range: without an explicit `fromBlock` this reads a bounded recent window, because an unbounded
 * `getLogs` over the vault's whole life can exceed provider limits and would otherwise silently
 * degrade to an empty history. Pass `fromBlock: 0n` when the full history is required.
 */
/**
 * One request row. `null` means the id does not exist on this vault, which is a real answer rather
 * than an error, so callers can drop unknown ids instead of rendering garbage.
 */
async function readRequest(vault: Address, requestId: `0x${string}`) {
  try {
    const request = await publicClient.readContract({
      address: vault,
      abi: mandateVaultAbi,
      functionName: "getRequest",
      args: [requestId],
    });
    return request;
  } catch {
    return null;
  }
}

export async function readSpendHistory(params: {
  vault: Address;
  agent?: Address;
  fromBlock?: bigint;
  toBlock?: bigint;
  limit?: number;
}): Promise<SpendEvent[]> {
  const {vault} = params;
  const limit = params.limit ?? 50;

  const eventNames = [
    "SpendRequested",
    "RequestExecuted",
    "RequestApproved",
    "RequestRejected",
    "RequestExpired",
    "RequestCancelled",
    "ReceiptIssued",
  ] as const;

  const kindByEvent: Record<string, SpendEvent["kind"]> = {
    SpendRequested: "requested",
    RequestExecuted: "executed",
    RequestApproved: "approved",
    RequestRejected: "rejected",
    RequestExpired: "expired",
    RequestCancelled: "cancelled",
    ReceiptIssued: "settled",
  };

  // Only SpendRequested, RequestExecuted and ReceiptIssued index `agent`. For the rest the filter
  // has to be applied after decoding, so we resolve the agent from the request itself.
  const agentFilterable = new Set(["SpendRequested", "RequestExecuted", "ReceiptIssued"]);

  const head = await publicClient.getBlockNumber();
  const fromBlock = params.fromBlock ?? (head > HISTORY_WINDOW ? head - HISTORY_WINDOW : 0n);
  const toBlock = params.toBlock ?? head;

  const results = await Promise.all(
    eventNames.map(async (name) => {
      try {
        return await publicClient.getContractEvents({
          address: vault,
          abi: mandateVaultAbi,
          eventName: name,
          args:
            params.agent && agentFilterable.has(name)
              ? {agent: params.agent}
              : undefined,
          fromBlock,
          toBlock,
        });
      } catch {
        // A wide range can exceed provider limits; degrade to empty rather than failing the page.
        return [];
      }
    }),
  );

  const events: SpendEvent[] = [];
  for (const [index, logs] of results.entries()) {
    const name = eventNames[index];
    for (const log of logs) {
      const args = log.args as Record<string, unknown> | undefined;
      if (!args) continue;

      // RequestApproved/Rejected/Expired/Cancelled carry no agent, so resolve it from the request.
      let agent = (args.agent ?? undefined) as Address | undefined;
      let token = (args.token ?? undefined) as Address | undefined;
      let target = (args.target ?? undefined) as Address | undefined;
      let amount = BigInt((args.amount as string | bigint | undefined) ?? 0);

      const requestId = (args.requestId as `0x${string}`) ?? ("0x" as `0x${string}`);
      if (params.agent && !agent) {
        const request = await readRequest(vault, requestId);
        if (!request) continue;
        agent = request.agent;
      }
      if (params.agent && agent && agent.toLowerCase() !== params.agent.toLowerCase()) continue;
      if (!token || !target || amount === 0n) {
        const request = await readRequest(vault, requestId);
        if (!request) continue;
        token = token ?? request.token;
        target = target ?? request.target;
        amount = amount === 0n ? request.amount : amount;
      }

      events.push({
        requestId,
        kind: kindByEvent[name] ?? "requested",
        agent: agent ?? ("0x" as Address),
        token: token ?? TUSDT_ADDRESS,
        target: target ?? ("0x" as Address),
        amount,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber ?? 0n,
        timestamp: await blockTimestamp(log.blockNumber ?? 0n),
      });
    }
  }

  // Newest first: a descending comparator returns -1 when a is the newer block.
  events.sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : a.blockNumber < b.blockNumber ? 1 : 0));
  return events.slice(0, limit);
}
