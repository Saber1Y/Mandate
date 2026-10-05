import {NextResponse} from "next/server";
import type {Hex} from "viem";
import {authenticateAgent, AuthenticationError} from "@/lib/auth";
import {findCredentialByHash, touchCredential} from "@/lib/agents";
import {isBytes32, requestStatusName} from "@/lib/contracts";
import {readRequest} from "@/lib/relayer";

/**
 * GET /api/requests/[id] - one request, read from the chain.
 *
 * Scoped to the authenticated agent so a valid key cannot be used to read another agent's history.
 */
export async function GET(request: Request, context: {params: Promise<{id: string}>}) {
  const {id} = await context.params;
  if (!isBytes32(id)) {
    return NextResponse.json({error: "id must be a 32-byte request id."}, {status: 400});
  }

  let credential;
  try {
    credential = await authenticateAgent(request, findCredentialByHash);
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({error: e.message}, {status: e.status});
    }
    throw e;
  }
  touchCredential(credential.keyHash);

  const onChain = await readRequest(id.toLowerCase() as Hex);
  if (!onChain) return NextResponse.json({error: "Unknown request id."}, {status: 404});
  if (onChain.agent.toLowerCase() !== credential.agentAddress.toLowerCase()) {
    return NextResponse.json({error: "Request does not belong to this agent."}, {status: 403});
  }

  return NextResponse.json(serializeRequest(onChain));
}

/**
 * bigint cannot cross JSON, so every uint256 leaves as a decimal string. Amounts are never
 * serialized as JS numbers anywhere in this API.
 *
 * Local rather than exported: Next.js rejects non-handler exports from a route module.
 */
function serializeRequest(onChain: {
  agent: string;
  token: string;
  target: string;
  amount: bigint;
  approvals: number;
  status: number;
  requestedAt: bigint;
  expiresAt: bigint;
}) {
  return {
    agent: onChain.agent,
    token: onChain.token,
    recipient: onChain.target,
    amount: onChain.amount.toString(),
    approvals: onChain.approvals,
    status: requestStatusName(onChain.status),
    requestedAt: Number(onChain.requestedAt),
    expiresAt: Number(onChain.expiresAt),
  };
}