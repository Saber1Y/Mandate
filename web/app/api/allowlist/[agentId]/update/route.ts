import {NextRequest, NextResponse} from "next/server";
import {encodeFunctionData, isAddress, type Address} from "viem";
import {vaultAbi} from "@/lib/contracts";
import {getAgent} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Visitor self-service allowlist change for per-user vault agents.
 * The visitor owns their vault, so the server returns unsigned calldata for
 * `setAllowedService` that the visitor signs in their wallet; the DB mirror happens
 * after confirmation via /api/allowlist/[agentId]/sync.
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

  const maxPerTxUsdc = typeof body.maxPerTxUsdc === "number" && body.maxPerTxUsdc > 0 ? Math.round(body.maxPerTxUsdc * 1_000_000) : null;
  const dailyCapUsdc = typeof body.dailyCapUsdc === "number" && body.dailyCapUsdc > 0 ? Math.round(body.dailyCapUsdc * 1_000_000) : null;
  if (maxPerTxUsdc != null && dailyCapUsdc != null && maxPerTxUsdc > dailyCapUsdc) {
    return NextResponse.json({error: "Per-service per-tx budget cannot exceed its daily budget"}, {status: 400});
  }

  const allowed = body.allowed !== false;
  const label = body.label?.trim() || "service";
  const vault = agent.vault_address as Address;
  const short = `${address.slice(0, 8)}...${address.slice(-4)}`;
  const data = encodeFunctionData({
    abi: vaultAbi,
    functionName: "setAllowedService",
    args: [
      agent.address as Address,
      address as Address,
      label,
      BigInt(maxPerTxUsdc ?? 0),
      BigInt(dailyCapUsdc ?? 0),
      0n,
      allowed,
    ],
  });

  return NextResponse.json({
    tx: {
      to: vault,
      data,
      value: "0",
      description: allowed
        ? `Allow your agent to pay service ${label} (${short}) from your vault ${vault}`
        : `Remove service ${short} from your agent's payee allowlist on vault ${vault}`,
    },
    address,
    allowed,
    label,
    maxPerTxUsdc: maxPerTxUsdc != null ? maxPerTxUsdc / 1_000_000 : null,
    dailyCapUsdc: dailyCapUsdc != null ? dailyCapUsdc / 1_000_000 : null,
  });
}
