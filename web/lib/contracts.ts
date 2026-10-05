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
 * Minimal ERC-20 surface needed to read the treasury balance of the settlement token, plus the
 * approve/allowance pair the owner needs to fund the vault.
 *
 * There is deliberately no `transferFrom` helper. Mandate moves funds with `safeTransfer` from
 * vault-held balance, so the platform never needs an ERC-20 allowance from the treasury - which
 * means there is no allowance to leak. The allowance that does exist is the *owner's* allowance to
 * the vault for the one-time `deposit`, and it is the owner who grants it, never the server.
 */
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
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

/**
 * Approval threshold parsing, in one place because `0` and "missing" are not the same thing.
 *
 * `approvalThreshold == 0` means auto-approve: `requestSpend` files the request straight as Approved
 * and the executor settles it with no human signature. Any value above 0 requires that many distinct
 * approvers to sign on-chain first. That is the difference between an autonomous agent and a
 * supervised one, so it must never be coerced by accident.
 *
 * Writing this as `Number(x) || 1` is the bug this replaces: it silently turns an intentional 0 into
 * 1, which strips the human gate the operator explicitly asked to remove.
 */
export const MAX_APPROVAL_THRESHOLD = 3;

/** Parse a threshold, returning null for anything that is not a usable 0..MAX approval count. */
export function parseApprovalThreshold(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_APPROVAL_THRESHOLD) return null;
  return n;
}

/** Plain-language consequence of a threshold, so no form has to re-explain it. */
export function approvalThresholdHint(value: number | null): string {
  if (value === null) return `Whole number, 0 to ${MAX_APPROVAL_THRESHOLD}.`;
  if (value === 0) {
    return "0 = settles with no human signature. The on-chain policy is then the only control.";
  }
  return value === 1
    ? "1 = one owner or approver signs before it settles."
    : `${value} = ${value} distinct approvers must sign before it settles.`;
}