import {NextResponse} from "next/server";
import {
  claimAuthorizationNonce,
  issueAgentKey,
  rotateAgentKeys,
  revokeAgentKeys,
} from "@/lib/agents";
import {OwnerAuthorizationError, verifyCredentialAuthorization} from "@/lib/verifyCredentialAuth";
import type {CredentialAction} from "@/lib/credentialAuth";

/**
 * POST /api/agents/credentials
 *
 * Issue, rotate or revoke an agent API key.
 *
 * This is the only route in Mandate that mints a credential, and it is gated on a signature from
 * the vault owner read live from the chain. There is no server admin key, so a compromised server
 * can still not mint an agent credential for itself. The plaintext key is returned exactly once and
 * is never persisted; the database only ever holds its SHA-256 hash.
 */
export async function POST(request: Request) {
  let body: {action?: string; authorization?: unknown; signature?: unknown};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({error: "Body must be JSON."}, {status: 400});
  }

  const action = body.action;
  if (action !== "issue" && action !== "rotate" && action !== "revoke") {
    return NextResponse.json(
      {error: "action must be one of: issue, rotate, revoke."},
      {status: 400},
    );
  }

  let identity: {agentId: string; agentAddress: `0x${string}`; nonceHash: string};
  try {
    identity = await verifyCredentialAuthorization({
      authorization: body.authorization,
      signature: body.signature,
      action: action as CredentialAction,
    });
  } catch (e) {
    if (e instanceof OwnerAuthorizationError) {
      return NextResponse.json({error: e.message}, {status: e.status});
    }
    throw e;
  }

  // Claim the nonce before touching credentials, so a replayed signature cannot rotate a freshly
  // issued key away.
  if (!claimAuthorizationNonce({nonceHash: identity.nonceHash, action, agentId: identity.agentId})) {
    return NextResponse.json(
      {error: "That authorization has already been used. Sign a new one."},
      {status: 409},
    );
  }

  try {
    if (action === "revoke") {
      const revoked = await revokeAgentKeys(identity.agentId);
      return NextResponse.json({ok: true, action, agentId: identity.agentId, revoked});
    }

    const {plaintext, credential} =
      action === "issue"
        ? await issueAgentKey({agentId: identity.agentId, agentAddress: identity.agentAddress})
        : await rotateAgentKeys(identity.agentId);

    return NextResponse.json({
      ok: true,
      action,
      agentId: credential.agentId,
      agentAddress: credential.agentAddress,
      keyHint: credential.keyHint,
      createdAt: credential.createdAt,
      // Shown once. Storing it anywhere would make revocation meaningless.
      apiKey: plaintext,
      warning: "This key is not recoverable. Store it now and revoke it when it leaks.",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({error: message.slice(0, 300)}, {status: 500});
  }
}
