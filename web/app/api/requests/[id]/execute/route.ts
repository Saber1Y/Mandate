import {NextResponse} from "next/server";
import type {Hex} from "viem";
import {authenticateAgent, AuthenticationError} from "@/lib/auth";
import {findCredentialByHash, touchCredential} from "@/lib/agents";
import {isBytes32, requestStatusName} from "@/lib/contracts";
import {relayExecute, readRequest} from "@/lib/relayer";

/**
 * Settle an approved request.
 *
 * POST /api/requests/[id]/execute
 *
 * The relayer calls `execute`, which only succeeds when the request is Approved on-chain AND the
 * full policy still holds at settlement time. Authentication is still required so an unauthenticated
 * caller cannot use this endpoint as a free execution service.
 */
export async function POST(request: Request, context: {params: Promise<{id: string}>}) {
  const {id} = await context.params;
  if (!isBytes32(id)) {
    return NextResponse.json({error: "id must be a 32-byte request id."}, {status: 400});
  }
  const requestId = id.toLowerCase() as Hex;

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

  // Vault comes from the credential; there is no deployment-wide default to fall back to.
  const vault = credential.vault;
  if (!vault) {
    return NextResponse.json(
      {error: "This credential is not scoped to a vault. Rotate the key to re-issue it."},
      {status: 409},
    );
  }

  const before = await readRequest(vault, requestId);
  if (!before) {
    return NextResponse.json({error: "Unknown request id."}, {status: 404});
  }
  if (before.agent.toLowerCase() !== credential.agentAddress.toLowerCase()) {
    return NextResponse.json({error: "Request does not belong to this agent."}, {status: 403});
  }

  const result = await relayExecute(vault, requestId);
  if (!result.success) {
    const status = result.reason ? 422 : 502;
    return NextResponse.json(
      {error: result.error ?? "Execution failed.", reason: result.reason ?? null},
      {status},
    );
  }

  const after = await readRequest(vault, requestId);
  return NextResponse.json({
    requestId,
    executeTxHash: result.txHash,
    status: after ? requestStatusName(after.status) : "Executed",
  });
}