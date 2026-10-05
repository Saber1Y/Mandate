import {NextResponse} from "next/server";
import type {Address} from "viem";
import {BOT_CHAIN_ID, TUSDT_ADDRESS, mandateFactory, MissingMandateConfigError} from "@/lib/bot";
import {publicClient} from "@/lib/chain";
import {mandateVaultFactoryAbi} from "@/lib/abi/mandate";
import {erc20Abi} from "@/lib/contracts";

/**
 * GET /api/health
 *
 * Reports what is actually configured and reachable. Intentionally exposes no secret and no
 * sensitive state: a health endpoint is public, so it must be useless to an attacker even when
 * scraped. It returns configuration SHAPE and chain liveness, never key material.
 */
export async function GET() {
  const report: Record<string, unknown> = {
    service: "mandate",
    expectedChainId: BOT_CHAIN_ID,
  };

  // No single vault is reported here. Which vault is live depends on who is asking, so a
  // deployment-wide health check can only speak about the factory and the network.
  let factory: Address | null = null;
  try {
    factory = mandateFactory();
    report.factory = factory;
  } catch (e) {
    report.configError =
      e instanceof MissingMandateConfigError ? e.message : "Mandate factory address is not configured.";
  }

  try {
    const chainId = await publicClient.getChainId();
    report.chainId = chainId;
    report.rpcReachable = true;
    report.chainMismatch = chainId !== BOT_CHAIN_ID;
  } catch (e) {
    report.rpcReachable = false;
    report.chainError = e instanceof Error ? e.message.slice(0, 200) : "unknown";
  }

  report.tusdt = TUSDT_ADDRESS;

  if (factory) {
    try {
      const [factoryCode, tokenDecimals, vaultCount, executor] = await Promise.all([
        publicClient.getCode({address: factory}),
        publicClient.readContract({address: TUSDT_ADDRESS, abi: erc20Abi, functionName: "decimals"}),
        publicClient.readContract({address: factory, abi: mandateVaultFactoryAbi, functionName: "vaultCount"}),
        publicClient.readContract({address: factory, abi: mandateVaultFactoryAbi, functionName: "executor"}),
      ]);
      report.factoryDeployed = !!factoryCode && factoryCode !== "0x";
      report.tusdtDecimals = Number(tokenDecimals);
      report.vaultCount = vaultCount.toString();
      report.executor = executor;
      report.relayerConfigured = !!process.env.EXECUTOR_PRIVATE_KEY;
    } catch (e) {
      report.contractReadError = e instanceof Error ? e.message.slice(0, 200) : "unknown";
    }
  }

  const healthy =
    report.rpcReachable === true &&
    report.chainMismatch !== true &&
    report.factoryDeployed === true &&
    report.tusdtDecimals === 6;

  return NextResponse.json({...report, healthy}, {status: healthy ? 200 : 503});
}