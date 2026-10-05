"use client";

import {useCallback, useEffect, useState} from "react";
import {isAddress, type Address, type Hex} from "viem";
import {BOT_CHAIN_ID, BOT_RPC_URL, BOT_EXPLORER_URL, TUSDT_ADDRESS, mandateFactory} from "@/lib/bot";
import {mandateVaultAbi, mandateVaultFactoryAbi} from "@/lib/abi/mandate";
import {publicClient} from "@/lib/chain";
import {erc20Abi} from "@/lib/contracts";
import {isSameAddress, tryParseTusdt, truncateAddress, truncateHash, formatTusdt} from "@/lib/format";
import {explorerAddress, explorerTx} from "@/lib/chain";
import {useTreasuryState} from "@/lib/useChainRead";
import {useActiveAddress} from "@/lib/usePrivyWallet";
import {useOwnerWrite} from "@/lib/useOwnerWrite";
import {useRole} from "@/lib/useRole";
import {useVault} from "@/lib/useVault";
import {Panel, PanelNote} from "@/components/dashboard/Panel";
import {Button} from "@/components/ui/Button";
import {Field, TextInput} from "@/components/ui/Input";
import {Skeleton} from "@/components/ui/Row";
import {PageLoader} from "@/components/ui/PageLoader";

/** tUSDT, or the chain's native gas token as the contract spells it. */
type WithdrawToken = Address | "native";
const NATIVE = "native" as const;

interface DeploymentInfo {
  chainId: number;
  vaultOwner: Address;
  factoryExecutor: Address;
  deployer: Address;
  vaultCount: bigint;
}

/** Deployment facts and relayer posture. Read-only, but it is where an operator confirms the app points at the right vault. */
export default function SettingsPage() {
  const {vault} = useVault();
  const treasury = useTreasuryState(vault);
  const {address} = useActiveAddress();
  const {isOwner, vaultOwner} = useRole();
  const [deployment, setDeployment] = useState<DeploymentInfo | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      const factory = mandateFactory();
      // MandateVaultFactory is deliberately not Ownable: it has no owner, only an immutable
      // executor and the original deployer. The vault owner is the org that called createVault.
      const [chainId, vaultOwnerOnChain, factoryExecutor, deployer, vaultCount] = await Promise.all([
        publicClient.getChainId(),
        // Resolved from the connected address rather than configured, so "your authority" always
        // describes the treasury this session can actually act on.
        publicClient.readContract({
          address: vault as Address,
          abi: mandateVaultAbi,
          functionName: "owner",
        }),
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
  }, [vault]);

  useEffect(() => {
    void load();
  }, [load]);

  if (treasury.loading) return <PageLoader label="Reading deployment..." fill />;

  const factory = (() => {
    try {
      return mandateFactory();
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
          {factory && vault ? (
            <dl className="grid gap-3 sm:grid-cols-2">
              <Detail label="Your vault" href={explorerAddress(vault)}>
                {vault}
              </Detail>
              <Detail label="Factory" href={explorerAddress(factory)}>
                {factory}
              </Detail>
            </dl>
          ) : (
            <PanelNote tone="error">
              The Mandate factory address is not configured. Set NEXT_PUBLIC_MANDATE_FACTORY_ADDRESS.
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

{isOwner && vault && treasury.data ? (
          <OwnerWithdraw vault={vault} destination={address} balance={treasury.data.treasuryBalance} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Owner-only treasury withdrawal.
 *
 * `withdrawToken` is `onlyOwner`, so an approver without owner authority never sees this. The form
 * defaults the destination to the connected owner wallet rather than to a stored value, because a
 * remembered recipient is exactly how funds get sent somewhere nobody re-reads.
 */
function OwnerWithdraw({
  vault,
  destination,
  balance,
}: {
  vault: Address;
  destination: Address | undefined;
  balance: bigint;
}) {
  const [recipient, setRecipient] = useState(destination ?? "");
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<WithdrawToken>(TUSDT_ADDRESS);
  const [done, setDone] = useState<Hex | undefined>();

  // The read-back matters most here: withdrawing only counts as done once the chain confirms it,
  // and the treasury balance the parent re-reads is what proves the money actually left.
  const onWithdrawn = useCallback((hash?: Hex) => setDone(hash), []);
  const withdraw = useOwnerWrite(onWithdrawn);

  const to = recipient.trim();
  const parsed = tryParseTusdt(amount);
  const amountFilled = amount.trim() !== "";

  const error = !isAddress(to)
    ? "Recipient must be a valid address."
    : amountFilled && parsed === null
      ? token === NATIVE
        ? "Amount must be an integer in wei. tUSDT amounts may use up to 6 decimal places."
        : "Amount must be a tUSDT amount with up to 6 decimal places."
      : amountFilled && parsed !== null && parsed <= 0n
        ? "Amount must be greater than zero."
        : token !== NATIVE && parsed !== null && parsed > balance
          ? "Amount is more than the treasury holds."
          : undefined;

  return (
    <Panel title="Withdraw from treasury" subtitle="Owner only. Moves funds out of Mandate entirely.">
      <form
        className="space-y-4"
onSubmit={(e) => {
              e.preventDefault();
              // Empty amount is a no-op rather than an error: the form stays disabled only on a
              // genuinely invalid value, and an untouched field should not block typing.
              if (error || parsed === null || parsed <= 0n) return;
              setDone(undefined);
              void withdraw.run({
                address: vault,
                abi: mandateVaultAbi,
                functionName: "withdrawToken",
                args: [token, to as Address, parsed],
              });
            }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Token">
            <select
              value={token}
              onChange={(e) => {
                setToken(e.target.value as WithdrawToken);
                setDone(undefined);
              }}
              className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-text-primary outline-none focus:border-accent"
            >
              <option value={TUSDT_ADDRESS}>tUSDT</option>
              <option value={NATIVE}>Native gas token</option>
            </select>
          </Field>
          <Field label="Amount">
            <TextInput
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setDone(undefined);
              }}
              inputMode="decimal"
              placeholder={token === NATIVE ? "wei" : "e.g. 25.00"}
            />
          </Field>
          <Field label="Recipient" hint="Defaults to your connected wallet.">
            <TextInput
              value={recipient}
              onChange={(e) => {
                setRecipient(e.target.value);
                setDone(undefined);
              }}
              placeholder={destination ?? "0x…"}
              className="font-mono"
            />
          </Field>
        </div>

        {error ? <p className="text-[12px] text-state-blocked">{error}</p> : null}
        {withdraw.error ? <p className="text-[12px] text-state-blocked">{withdraw.error}</p> : null}
        {done ? (
          <p className="text-[12px] text-state-ok">
            Withdrawn in{" "}
            <a href={explorerTx(done)} target="_blank" rel="noopener noreferrer" className="font-mono text-accent hover:underline">
              {truncateHash(done)}
            </a>
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <p className="text-[11px] text-text-muted">
            Treasury holds {formatTusdt(balance)} tUSDT. Withdrawing is not reversible from Mandate.
          </p>
          <Button type="submit" disabled={!!error || withdraw.pending || !amountFilled}>
            {withdraw.pending ? "Confirming..." : "Withdraw"}
          </Button>
        </div>
      </form>
    </Panel>
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