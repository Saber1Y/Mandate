import {NextResponse} from "next/server";
import {type Address, type Hex, isAddress} from "viem";
import {authenticateAgent, AuthenticationError} from "@/lib/auth";
import {findCredentialByHash, touchCredential} from "@/lib/agents";
import {TUSDT_ADDRESS} from "@/lib/bot";
import {publicClient} from "@/lib/chain";
import {mandateVaultAbi} from "@/lib/abi/mandate";
import {isBytes32, requestStatusName} from "@/lib/contracts";
import {assertExecutorRegistered, readRequest, relayRequestSpend} from "@/lib/relayer";

/**
 * Agent spend request.
 *
 * POST /api/requests
 *
 * The agent authenticates with its bearer key. The on-chain agent address comes from the
 * credential, never from the request body, so a caller cannot request against another agent.
 *
 * The relayer submits `requestSpend`. MandateVault validates the agent's caps, expiry, token
 * allowlist and recipient allowlist on-chain. If the request violates policy the call reverts here
 * and never reaches an approver - this route does not pre-approve anything, because it cannot.
 */
export async function POST(request: Request) {
  let body: {
    recipient?: string;
    amount?: string;
    token?: string;
    idempotencyKey?: string;
    expiresAt?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({error: "Body must be JSON."}, {status: 400});
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

  if (!isAddress(body.recipient ?? "")) {
    return NextResponse.json({error: "recipient must be a valid address."}, {status: 400});
  }

  // Base units, as a decimal string of uint256. Accepting a float here is how rounding bugs get in.
  let amount: bigint;
  try {
    amount = parseBaseUnits(body.amount);
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 400});
  }
  if (amount <= 0n) {
    return NextResponse.json({error: "amount must be greater than zero."}, {status: 400});
  }

  // An unusable token is a client error. This used to throw past the handler and surface as an
  // empty HTTP 500, which reads like a server fault rather than a malformed request.
  let token: Address;
  try {
    token = body.token ? validateAddress(body.token, "token") : TUSDT_ADDRESS;
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 400});
  }

  // Idempotency: required, so a retried request can never become two spends. Accept a 32-byte hex
  // key or derive a stable one from the authenticated agent plus the caller's key material.
  let idempotencyKey: Hex;
  if (body.idempotencyKey) {
    if (!isBytes32(body.idempotencyKey)) {
      return NextResponse.json(
        {error: "idempotencyKey must be 32 bytes of hex (0x + 64 characters)."},
        {status: 400},
      );
    }
    idempotencyKey = body.idempotencyKey.toLowerCase() as Hex;
  } else {
    const header = request.headers.get("idempotency-key");
    if (header && isBytes32(header)) {
      idempotencyKey = header.toLowerCase() as Hex;
    } else {
      return NextResponse.json(
        {error: "Provide an Idempotency-Key header or a 32-byte idempotencyKey in the body."},
        {status: 400},
      );
    }
  }

  let expiresAt: bigint;
  try {
    expiresAt = body.expiresAt ? parseTimestamp(body.expiresAt) : 0n;
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 400});
  }

  // Scope comes from the credential. A key is bound to one vault at issue time, so this cannot be
  // redirected at another org's treasury by anything in the request body.
  const vault = credential.vault;
  if (!vault) {
    return NextResponse.json(
      {error: "This credential is not scoped to a vault. Rotate the key to re-issue it."},
      {status: 409},
    );
  }

  try {
    await assertExecutorRegistered(vault);
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 503});
  }

  const result = await relayRequestSpend({
    vault,
    agent: credential.agentAddress,
    token,
    recipient: body.recipient as Address,
    amount,
    idempotencyKey,
    expiresAt: expiresAt,
  });

  if (!result.success) {
    // Surface the contract's custom error so an agent can tell "not allowlisted" from "over cap".
    const status = result.reason ? 422 : 502;
    return NextResponse.json(
      {error: result.error ?? "Relayed request failed.", reason: result.reason ?? null},
      {status},
    );
  }

  const requestId = await deriveRequestId(vault, idempotencyKey);
  const onChain = requestId ? await readRequest(vault, requestId) : null;

  return NextResponse.json(
    {
      requestId,
      requestTxHash: result.txHash,
      status: onChain ? requestStatusName(onChain.status) : "Pending",
      agent: credential.agentAddress,
      token,
      recipient: body.recipient,
      amount: amount.toString(),
      expiresAt: onChain ? Number(onChain.expiresAt) : null,
      approvals: onChain ? Number(onChain.approvals) : 0,
    },
    {status: 201},
  );
}

function validateAddress(value: string, field: string): Address {
  if (!isAddress(value)) throw new Error(`${field} must be a valid address.`);
  return value as Address;
}

function parseBaseUnits(value: string | undefined): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new Error("amount must be an integer string in token base units (uint256), not a decimal.");
  }
  const parsed = BigInt(value.trim());
  if (parsed > 2n ** 256n - 1n) throw new Error("amount exceeds uint256.");
  return parsed;
}

function parseTimestamp(value: string): bigint {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error("expiresAt must be a unix timestamp in seconds.");
  return BigInt(Math.floor(n));
}

/** Mirrors MandateVault.computeRequestId so clients can correlate without guessing. */
async function deriveRequestId(vault: Address, idempotencyKey: Hex): Promise<Hex | null> {
  try {
    return (await publicClient.readContract({
      address: vault,
      abi: mandateVaultAbi,
      functionName: "computeRequestId",
      args: [idempotencyKey],
    })) as Hex;
  } catch {
    return null;
  }
}
