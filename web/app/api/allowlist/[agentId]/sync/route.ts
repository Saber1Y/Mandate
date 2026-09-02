import {NextRequest, NextResponse} from "next/server";
import {isAddress, type Address} from "viem";
import {getAgent, listAllowlistEntries, addAllowlistEntry, removeAllowlistEntry, setAllowlistEntryPolicy} from "@/lib/db";
import {getVaultService} from "@/lib/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * After the visitor signs the allowlist change in their wallet, mirror the confirmed
 * on-chain `serviceAllowlist` state into the server store so both fences stay in sync.
 * Verifies the vault actually reflects the requested value before writing.
 */
export async function POST(req: NextRequest, {params}: {params: Promise<{agentId: string}>}) {
  const {agentId} = await params;
  const agent = getAgent(agentId);
  if (!agent) return NextResponse.json({error: "Agent not found"}, {status: 404});
  if (!agent.vault_address) {
    return NextResponse.json({error: "Agent is not backed by a per-user vault"}, {status: 400});
  }

  let body: {address?: string; allowed?: boolean; label?: string; maxPerTxUsdc?: number; dailyCapUsdc?: number};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({error: "invalid request"}, {status: 400});
  }

  const address = (body.address ?? "").trim();
  if (!isAddress(address)) {
    return NextResponse.json({error: "A valid recipient address is required"}, {status: 400});
  }
  const allowed = body.allowed !== false;
  const label = body.label?.trim() || "service";
  const maxPerTxUsdc = typeof body.maxPerTxUsdc === "number" && body.maxPerTxUsdc > 0 ? Math.round(body.maxPerTxUsdc * 1_000_000) : null;
  const dailyCapUsdc = typeof body.dailyCapUsdc === "number" && body.dailyCapUsdc > 0 ? Math.round(body.dailyCapUsdc * 1_000_000) : null;
  if (maxPerTxUsdc != null && dailyCapUsdc != null && maxPerTxUsdc > dailyCapUsdc) {
    return NextResponse.json({error: "Per-service per-tx budget cannot exceed its daily budget"}, {status: 400});
  }

  let service: {allowed: boolean; label: string; maxPerTx: bigint; dailyCap: bigint; expiry: bigint};
  try {
    service = await getVaultService(agent.vault_address as Address, agent.address as Address, address as Address);
  } catch {
    return NextResponse.json({error: "VAULT_READ_FAILED", message: "Could not read the vault allowlist on-chain."}, {status: 502});
  }

  const onchainMaxPerTx = maxPerTxUsdc == null ? 0n : BigInt(maxPerTxUsdc);
  const onchainDailyCap = dailyCapUsdc == null ? 0n : BigInt(dailyCapUsdc);
  if (service.allowed !== allowed) {
    return NextResponse.json(
      {
        error: "ONCHAIN_MISMATCH",
        message: `On-chain allowlist does not match - the vault shows this service as ${service.allowed ? "allowed" : "not allowed"}.`,
      },
      {status: 409},
    );
  }
  if (allowed && (service.maxPerTx !== onchainMaxPerTx || service.dailyCap !== onchainDailyCap)) {
    return NextResponse.json(
      {
        error: "ONCHAIN_MISMATCH",
        message: "On-chain per-service budget does not match the requested caps. Confirm the transaction, then retry.",
      },
      {status: 409},
    );
  }

  const existing = listAllowlistEntries(agentId, "recipient").find((r) => r.address.toLowerCase() === address.toLowerCase());
  if (allowed) {
    if (existing) {
      setAllowlistEntryPolicy(existing.id, maxPerTxUsdc, dailyCapUsdc);
    } else {
      addAllowlistEntry(agentId, "recipient", address, label, maxPerTxUsdc, dailyCapUsdc);
    }
  } else if (existing) {
    removeAllowlistEntry(existing.id);
  }

  return NextResponse.json({ok: true, address, allowed, label, maxPerTxUsdc, dailyCapUsdc});
}
