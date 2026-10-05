import {formatUnits, type Address} from "viem";
import {TUSDT_DECIMALS} from "./bot";

/**
 * tUSDT has 6 decimals, same as the USDC it replaces. All arithmetic stays in base units
 * (`uint256`) end to end; this is the only place a value becomes a human string.
 */
export function formatTusdt(base: bigint, opts: {maxFractionDigits?: number} = {}): string {
  const s = formatUnits(base, TUSDT_DECIMALS);
  const n = Number(s);
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: opts.maxFractionDigits ?? 2,
  });
}

/** Parse a human tUSDT string into base units. Throws on anything ambiguous rather than rounding. */
export function parseTusdt(amount: string): bigint {
  const raw = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid tUSDT amount: ${raw}`);
  }
  const [whole, frac = ""] = raw.split(".");
  if (frac.length > TUSDT_DECIMALS) {
    throw new Error(`tUSDT supports at most ${TUSDT_DECIMALS} decimal places`);
  }
  const padded = frac.padEnd(TUSDT_DECIMALS, "0");
  return BigInt(whole) * 10n ** BigInt(TUSDT_DECIMALS) + BigInt(padded || "0");
} 

/**
 * Non-throwing variant for render paths.
 *
 * `parseTusdt` throws by design so submit handlers can bail out. Calling it during render turns a
 * half-typed field like "1." or "" into a thrown error that unmounts the whole form, so any code
 * that parses while rendering must use this and handle the null.
 */
export function tryParseTusdt(amount: string): bigint | null {
  try {
    return parseTusdt(amount);
  } catch {
    return null;
  }
}

export function truncateAddress(addr: string, lead = 6, tail = 4): string {
  if (!addr) return "";
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}

export function truncateHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** unix seconds -> compact "3m ago" style, relative to now. */
export function timeAgo(unixSeconds: number, nowMs = Date.now()): string {
  const secs = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function formatExpiry(unixSeconds: bigint): {label: string; expired: boolean} {
  if (unixSeconds === 0n) return {label: "never", expired: false};
  const nowS = Math.floor(Date.now() / 1000);
  const expired = Number(unixSeconds) <= nowS;
  const d = new Date(Number(unixSeconds) * 1000);
  return {label: d.toLocaleDateString("en-US", {year: "numeric", month: "short", day: "numeric"}), expired};
}

export const isSameAddress = (a?: string, b?: string): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export type {Address};
