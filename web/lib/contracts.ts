import {parseAbi, type Address} from "viem";
import {mandateVaultAbi, mandateVaultFactoryAbi} from "./abi/mandate";
import {TUSDT_ADDRESS, TUSDT_DECIMALS, mandateFactory} from "./bot";

export {
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  TUSDT_ADDRESS,
  TUSDT_DECIMALS,
  mandateFactory,
};

/** Re-exported so UI code never hand-rolls base-unit arithmetic. */
export {parseTusdt, formatTusdt} from "./format";

/**
 * Minimal ERC-20 surface needed to read the treasury balance of the settlement token.
 *
 * There is deliberately no `approve` or `transfer` helper here. Mandate moves funds with
 * `safeTransfer` from vault-held balance, so the platform never needs an ERC-20 allowance from
 * the treasury - which means there is no allowance to leak, and no approve path to get wrong.
 */
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/** Native asset sentinel used by MandateVault to represent the chain's native currency (tBOT). */
export const NATIVE_SENTINEL = "0x0000000000000000000000000000000000000000" as Address;

/**
 * On-chain request lifecycle, mirroring MandateVault.RequestStatus.
 *
 * Order is the contract enum order: None, Pending, Approved, Rejected, Executed, Cancelled, Expired.
 * This was previously listed as ...Approved, Executed, Rejected, Expired, Cancelled, which made an
 * executed settlement report as "Rejected" and swapped the terminal states.
 */
export const REQUEST_STATUS = [
  "None",
  "Pending",
  "Approved",
  "Rejected",
  "Executed",
  "Cancelled",
  "Expired",
] as const;

export type RequestStatusName = (typeof REQUEST_STATUS)[number];

const STATUS_BY_INDEX: Record<number, RequestStatusName> = Object.fromEntries(
  REQUEST_STATUS.map((name, index) => [index, name]),
) as Record<number, RequestStatusName>;

/**
 * Decode MandateVault.RequestStatus into a name.
 *
 * The return type stays a string rather than the closed union: a status the deployed contract
 * reports but this build does not know about must surface as `Unknown(7)` in the UI instead of
 * being silently coerced into a valid-looking state.
 */
export function requestStatusName(index: number | bigint): string {
  const key = Number(index);
  return STATUS_BY_INDEX[key] ?? `Unknown(${key})`;
}

/**
 * True for exactly a 32-byte hex string.
 *
 * viem's `isHex` accepts only a `strict` flag, so it cannot verify byte length. A request id that
 * is the wrong width would be rejected by the contract anyway, but catching it here returns a 400
 * with a useful message instead of an opaque revert.
 */
export function isBytes32(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}