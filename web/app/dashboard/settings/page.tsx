"use client";

import {useCallback, useEffect, useState} from "react";
import type {Address} from "viem";
import {
  BOT_CHAIN_ID,
  BOT_RPC_URL,
  BOT_EXPLORER_URL,
  TUSDT_ADDRESS,
  mandateContracts,
} from "@/lib/bot";
import {mandateVaultAbi, mandateVaultFactoryAbi} from "@/lib/abi/mandate";
import {publicClient} from "@/lib/chain";
import {erc20Abi} from "@/lib/contracts";
import {isSameAddress, truncateAddress, formatTusdt} from "@/lib/format";
import {explorerAddress, explorerTx} from "@/lib/chain";
import {useTreasuryState} from "@/lib/useChainRead";
import {useActiveAddress} from "@/lib/usePrivyWallet";
import {useRole} from "@/lib/useRole";
import {Panel, PanelNote} from "@/components/dashboard/Panel";
import {Card} from "@/components/ui/Card";
import {StatTile} from "@/components/ui/StatTile";
import {CopyChip, TxChip} from "@/components/ui/Chip";
import {Skeleton} from "@/components/ui/Row";
import {PageLoader} from "@/components/ui/PageLoader";

interface DeploymentInfo {
  chainId: number;
  vaultOwner: Address;
  factoryExecutor: Address;
  deployer: Address;
  vaultCount: bigint;
}

/** Deployment facts and relayer posture. Read-only, but it is where an operator confirms the app points at the right vault. */
export default function SettingsPage() {
  const treasury = useTreasuryState();
  const {address} = useActiveAddress();
  const {isOwner, vaultOwner} = useRole();
  const [deployment, setDeployment] = useState<DeploymentInfo | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      const {vault, factory} = mandateContracts();
      // MandateVaultFactory is deliberately not Ownable: it has no owner, only an immutable
      // executor and the original deployer. The vault owner is the org that called createVault.
      const [chainId, vaultOwnerOnChain, factoryExecutor, deployer, vaultCount] = await Promise.all([
        publicClient.getChainId(),
        publicClient.readContract({address: vault, abi: mandateVaultAbi, functionName: "owner"}),
        publicClient.readContract({address: factory, abi: mandateVaultFactoryAbi, functionName: "executor"}),
        publicClient.readContract({address: factory, abi: mandateVaultFactoryAbi, functionName: "deployer"}),
        publicClient.readContract({address: factory, abi: mandateVaultFactoryAbi, functionName: "vaultCount"}),
      ]);
      setDeployment({
        chainId,
        vaultOwner: vaultOwnerOnChain as Address,
        factoryExecutor: factoryExecutor as Address,
        deployer: deployer as Address,
        vaultCount,
      });
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the factory.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (treasury.loading) return <PageLoader label="Reading deployment..." fill />;

  const contracts = (() => {
    try {
      return mandateContracts();
    } catch {
      return null;
    }
  })();

  /**
   * Separation of powers, stated plainly.
   *
   * If the owner and the factory executor are the same address, one key can both approve a spend
   * and broadcast it. That is fine for a testnet demo and unacceptable for an organization holding
   * real funds, so it is surfaced rather than buried.
   */
  const keysCollide =
    deployment !== undefined && isSameAddress(deployment.vaultOwner, deployment.factoryExecutor);

  return (
    <div className="p-6">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold text-text-primary tracking-tight">Settings</h1>
        <p className="mt-1 text-[13px] text-text-muted">Where this console is pointed, and who holds authority.</p>
      </header>

      {keysCollide ? (
        <div className="mb-4 rounded-lg border border-state-pending/40 bg-state-pending-light px-4 py-3">
          <div className="text-[13px] font-semibold text-text-primary">
            Owner and executor are the same address on this deployment.
          </div>
          <p className="mt-1 text-[12px] text-text-secondary">
            A single key can approve and settle. Before an organization holds real funds, deploy a
            fresh vault owned by the org smart account with a distinct gas-only executor.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4">
        <Panel title="Network">
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Detail label="Chain">
              {deployment?.chainId ?? "-"}
              {deployment && deployment.chainId !== BOT_CHAIN_ID ? (
                <span className="ml-2 text-state-blocked">expected {BOT_CHAIN_ID}</span>
              ) : null}
            </Detail>
            <Detail label="RPC">{BOT_RPC_URL}</Detail>
            <Detail label="Explorer">{BOT_EXPLORER_URL}</Detail>
            <Detail label="tUSDT" href={explorerAddress(TUSDT_ADDRESS)}>
              {TUSDT_ADDRESS}
            </Detail>
          </dl>
        </Panel>

        <Panel title="Contracts">
          {contracts ? (
            <dl className="grid gap-3 sm:grid-cols-2">
              <Detail label="Vault" href={explorerAddress(contracts.vault)}>
                {contracts.vault}
              </Detail>
              <Detail label="Factory" href={explorerAddress(contracts.factory)}>
                {contracts.factory}
              </Detail>
            </dl>
          ) : (
            <PanelNote tone="error">
              Mandate addresses are not configured. Set MANDATE_VAULT_ADDRESS and
              MANDATE_FACTORY_ADDRESS in the environment.
            </PanelNote>
          )}
          {error ? <p className="mt-3 text-[12px] text-state-blocked">{error}</p> : null}
        </Panel>

        <Panel title="Authority" subtitle="Who can approve, and who can settle">
          {deployment ? (
            <dl className="grid gap-3 sm:grid-cols-2">
              <Detail label="Vault owner (approves)" href={explorerAddress(deployment.vaultOwner)}>
                {deployment.vaultOwner}
              </Detail>
              <Detail label="Factory executor (settles)" href={explorerAddress(deployment.factoryExecutor)}>
                {deployment.factoryExecutor}
              </Detail>
              <Detail label="Factory deployer" href={explorerAddress(deployment.deployer)}>
                {deployment.deployer}
              </Detail>
            </dl>
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-2/3" />
            </div>
          )}
        </Panel>

        <Panel title="Your session">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label="Connected wallet">{address ?? "not connected"}</Detail>
            <Detail label="Your role">
              {address === undefined
                ? "-"
                : isOwner
                  ? "owner"
                  : vaultOwner && isSameAddress(address, vaultOwner)
                    ? "owner"
                    : "not an approver"}
            </Detail>
          </dl>
        </Panel>
      </div>
    </div>
  );
}

function Detail({label, children, href}: {label: string; children: React.ReactNode; href?: string}) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="mt-1 break-all text-[12px] text-text-primary">
        {href && typeof children === "string" ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-accent hover:underline">
            {truncateAddress(children)}
          </a>
        ) : (
          children
        )}
      </dd>
    </div>
  );
}