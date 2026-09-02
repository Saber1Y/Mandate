import {parseAbi, type Address} from "viem";
import {USDC_ADDRESS} from "./arc";

/** SpendArc deployment on Arc testnet. Addresses are populated after deployment. */
export const CONTRACTS = {
  usdc: USDC_ADDRESS,
  vault: (process.env.NEXT_PUBLIC_VAULT_ADDRESS || "0x0000000000000000000000000000000000000000") as Address,
  factory: (process.env.NEXT_PUBLIC_FACTORY_ADDRESS || "0x0000000000000000000000000000000000000000") as Address,
} as const satisfies Record<string, Address>;

export const USDC_DECIMALS = 6;

/** The demo agent (also the vault owner) deployed on Arc testnet. */
export const AGENT_ADDRESS = "0x3F5b96A494061F7338Da529e3047809Ac6a7FB84" as Address;

export const vaultAbi = parseAbi([
  // reads
  "function getPolicy(address agent) view returns ((uint128 maxPerTx,uint128 dailyCap,uint128 spentToday,uint64 lastResetTime,uint64 expiry,bool active))",
  "function remainingDailyCap(address agent) view returns (uint256)",
  "function getService(address agent,address target) view returns ((bool allowed,string label,uint128 maxPerTx,uint128 dailyCap,uint128 spentToday,uint64 lastResetTime,uint64 expiry))",
  "function remainingServiceDailyCap(address agent,address target) view returns (uint256)",
  "function isAllowed(address agent,address target,address token) view returns (bool)",
  "function allowedToken(address agent,address token) view returns (bool)",
  "function usedAction(bytes32 actionId) view returns (bool)",
  "function owner() view returns (address)",
  "function executors(address) view returns (bool)",
  "function NATIVE() view returns (address)",
  // owner writes
  "function setAgentPolicy(address agent,uint128 maxPerTx,uint128 dailyCap,uint64 expiry,bool active)",
  "function setAllowedService(address agent,address target,string label,uint128 maxPerTx,uint128 dailyCap,uint64 expiry,bool allowed)",
  "function setAllowedToken(address agent,address token,bool allowed)",
  "function revokeAgent(address agent)",
  "function withdrawTokens(address token,address to,uint256 amount)",
  "function setExecutor(address executor,bool enabled)",
  "function deposit(uint256 amount)",
  "function usdc() view returns (address)",
  // agent actions
  "function executeSpend(address token,address target,uint256 amount,bytes data,bytes32 actionId) returns (bool)",
  "function executeSpendFor(address agent,address token,address target,uint256 amount,bytes data,bytes32 actionId) returns (bool)",
  // events
  "event AgentActionApproved(address indexed agent,address indexed target,address indexed token,uint256 amount,bytes32 actionId)",
  "event AgentActionBlocked(address indexed agent,address indexed target,address indexed token,uint256 amount,string reason)",
  "event ReceiptIssued(address indexed agent,address indexed target,address token,uint256 amount,bytes32 actionId,uint256 timestamp)",
  "event VaultFunded(address indexed from,uint256 amount)",
  "event PolicyCreated(address indexed agent,uint128 maxPerTx,uint128 dailyCap,uint64 expiry,bool active)",
  "event PolicyUpdated(address indexed agent,uint128 maxPerTx,uint128 dailyCap,uint64 expiry,bool active)",
  "event ServiceAllowlisted(address indexed agent,address indexed target,string label,uint128 maxPerTx,uint128 dailyCap,uint64 expiry,bool allowed)",
  "event TokenAllowlisted(address indexed agent,address indexed token,bool allowed)",
  "event AgentRevoked(address indexed agent)",
  "event ExecutorSet(address indexed executor,bool enabled)",
]);

export const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export const factoryAbi = parseAbi([
  "function createVault(uint128 maxPerTx,uint128 dailyCap,uint64 expiry) returns (address)",
  "function vaultOf(address owner) view returns (address)",
  "function vaultByAgent(address agent) view returns (address)",
  "function vaultCount() view returns (uint256)",
  "function usdc() view returns (address)",
  "function executor() view returns (address)",
  "event VaultCreated(address indexed owner,address indexed agent,address vault,uint128 maxPerTx,uint128 dailyCap)",
]);


