import {NextResponse} from "next/server";
import {authenticateAgent, AuthenticationError} from "@/lib/auth";
import {findCredentialByHash, touchCredential} from "@/lib/agents";
import {TUSDT_ADDRESS, botChain} from "@/lib/bot";
import {publicClient} from "@/lib/chain";
import {mandateVaultAbi} from "@/lib/abi/mandate";
import {erc20Abi} from "@/lib/contracts";
import {requestStatusName} from "@/lib/contracts";

/**
 * GET /api/agents/me
 *
 * The authenticated agent's identity plus its LIVE on-chain policy and remaining budget.
 *
 * There is no database copy of any of this. If the owner tightens a cap on-chain, the next call
 * here already reflects it. That removes the entire class of bug where the API advertised a limit
 * the contract would not honour.
 */
export async function GET(request: Request) {
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

  // The vault comes from the credential, never from a deployment-wide setting. This is what scopes
  // a key to exactly one treasury: a key issued by org A cannot read org B's policy.
  const vault = credential.vault;
  if (!vault) {
    return NextResponse.json(
      {error: "This credential is not scoped to a vault. Rotate the key to re-issue it."},
      {status: 409},
    );
  }

  const agent = credential.agentAddress;

  try {
    const [policy, remaining, tokenAllowed, treasuryBalance, owner, isRegistered] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: "getPolicy",
        args: [agent],
      }) as Promise<{
        maxPerTx: bigint;
        dailyCap: bigint;
        spentToday: bigint;
        lastResetTime: bigint;
        expiry: bigint;
        approvalThreshold: number;
        active: boolean;
      }>,
      publicClient.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: "remainingDailyCap",
        args: [agent],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: "allowedTokens",
        args: [agent, TUSDT_ADDRESS],
      }) as Promise<boolean>,
      publicClient.readContract({
        address: TUSDT_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: "owner",
      }) as Promise<`0x${string}`>,
      publicClient.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: "agents",
        args: [agent],
      }) as Promise<boolean>,
    ]);

    return NextResponse.json({
      agentId: credential.agentId,
      agentAddress: agent,
      keyHint: credential.keyHint,
      vault,
      vaultOwner: owner,
      chainId: botChain.id,
      registeredOnChain: isRegistered,
      treasuryBalance: treasuryBalance.toString(),
      token: {address: TUSDT_ADDRESS, decimals: 6},
      policy: {
        maxPerTx: policy.maxPerTx.toString(),
        dailyCap: policy.dailyCap.toString(),
        spentToday: policy.spentToday.toString(),
        remainingDailyCap: remaining.toString(),
        lastResetTime: Number(policy.lastResetTime),
        expiry: Number(policy.expiry),
        approvalThreshold: policy.approvalThreshold,
        active: policy.active,
      },
      tokenAllowed,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {error: "Could not read vault state from the chain.", detail: message.slice(0, 300)},
      {status: 502},
    );
  }
}