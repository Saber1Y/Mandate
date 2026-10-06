"use client";

import {useCallback, useEffect, useState} from "react";
import {type Address} from "viem";
import {TUSDT_ADDRESS, TUSDT_DECIMALS} from "@/lib/bot";
import {mandateVaultAbi} from "@/lib/abi/mandate";
import {erc20Abi} from "@/lib/contracts";
import {publicClient} from "@/lib/chain";
import {formatTusdt, tryParseTusdt} from "@/lib/format";
import {useOwnerWrite} from "@/lib/useOwnerWrite";
import {useActiveAddress} from "@/lib/usePrivyWallet";
import {Panel, PanelNote} from "@/components/dashboard/Panel";
import {Button} from "@/components/ui/Button";
import {Field, TextInput} from "@/components/ui/Input";

/**
 * Funding the treasury, which is the step every flow starts from.
 *
 * A fresh vault holds nothing and `deposit` pulls with `safeTransferFrom`, so the owner has to grant
 * the vault an ERC-20 allowance first. That is a real second signature, and skipping it was the
 * reason a new vault looked complete while being unable to spend anything - there was no deposit UI
 * anywhere in the dashboard.
 *
 * The allowance is scoped to the vault the owner just created and to the exact amount being
 * deposited, then left in place because a repeated top-up would otherwise need a signature per
 * deposit. The spender is always this vault: never the platform, never the relayer.
 */
export function FundVault({
  vault,
  vaultBalance,
  onChanged,
}: {
  vault: Address;
  vaultBalance: bigint | undefined;
  onChanged: () => void;
}) {
  const {address} = useActiveAddress();
  const [walletBalance, setWalletBalance] = useState<bigint | undefined>();
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const [wallet, allowed] = await Promise.all([
        publicClient.readContract({
          address: TUSDT_ADDRESS,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }),
        publicClient.readContract({
          address: TUSDT_ADDRESS,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, vault],
        }),
      ]);
      setWalletBalance(wallet);
      setAllowance(allowed);
    } catch {
      // Advisory: a failed read must not block the form, the write will fail loudly instead.
    }
  }, [address, vault]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshAll = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  const approve = useOwnerWrite(refreshAll);
  const deposit = useOwnerWrite(refreshAll);

  const parsed = tryParseTusdt(amount);
  const amountError =
    amount.trim() === ""
      ? undefined
      : parsed === null
        ? "Enter a tUSDT amount with up to 6 decimal places."
        : parsed <= 0n
          ? "Amount must be greater than zero."
          : parsed > (walletBalance ?? 0n)
            ? "More than the connected wallet holds."
            : undefined;

  const needsApproval = parsed !== null && parsed > 0n && allowance < parsed;

  return (
    <Panel
      title="Fund the treasury"
      subtitle="The agent can only spend what is actually in the vault"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Figure label="In your wallet" value={walletBalance === undefined ? "…" : `${formatTusdt(walletBalance)} tUSDT`} />
        <Figure label="Vault allowance" value={allowance > 0n ? `${formatTusdt(allowance)} tUSDT` : "none"} />
        <Figure
          label="Vault balance"
          value={vaultBalance === undefined ? "…" : `${formatTusdt(vaultBalance)} tUSDT`}
          emphasis
        />
      </div>

      {vaultBalance !== undefined && vaultBalance === 0n ? (
        <p className="mt-3 text-[12px] text-state-pending">
          This treasury is empty. An agent cannot spend until it holds something.
        </p>
      ) : null}

      <form
        className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (amountError || parsed === null || parsed <= 0n) return;
          setError(undefined);
          // One signature when the allowance is short, then the deposit. Approving and depositing in
          // one go is not possible: approve is a token-contract call that must settle first.
          if (needsApproval) {
            void approve.run({
              address: TUSDT_ADDRESS,
              abi: erc20Abi,
              functionName: "approve",
              args: [vault, parsed],
            });
            return;
          }
          void deposit.run({
            address: vault,
            abi: mandateVaultAbi,
            functionName: "deposit",
            args: [TUSDT_ADDRESS, parsed],
          });
        }}
      >
        <div className="min-w-[200px] flex-1">
          <Field label="Deposit amount" hint={`tUSDT has ${TUSDT_DECIMALS} decimals.`}>
            <TextInput
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setError(undefined);
              }}
              inputMode="decimal"
              placeholder="0.00"
            />
          </Field>
        </div>
        <Button type="submit" disabled={!!amountError || approve.pending || deposit.pending}>
          {approve.pending
            ? "Approving..."
            : deposit.pending
              ? "Depositing..."
              : needsApproval
                ? "Approve vault"
                : "Deposit"}
        </Button>
      </form>

      {needsApproval && parsed !== null && parsed > 0n ? (
        <p className="mt-2 text-[11px] text-text-muted">
          Approving lets this vault pull {formatTusdt(parsed)} tUSDT from your wallet, and only for
          this amount. Approve again if you later deposit more.
        </p>
      ) : null}

      {amountError ? <p className="mt-2 text-[12px] text-state-blocked">{amountError}</p> : null}
      {error ? <p className="mt-2 text-[12px] text-state-blocked">{error}</p> : null}
      {approve.error ? <p className="mt-2 text-[12px] text-state-blocked">{approve.error}</p> : null}
      {deposit.error ? <p className="mt-2 text-[12px] text-state-blocked">{deposit.error}</p> : null}
    </Panel>
  );
}

function Figure({label, value, emphasis}: {label: string; value: string; emphasis?: boolean}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-text-muted">{label}</div>
      <div
        className={`mt-1 text-[15px] font-semibold tabular-nums ${
          emphasis ? "text-accent" : "text-text-primary"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Owner-only exit.
 *
 * Kept separate from the deposit form because it moves money out of the platform entirely, which is a
 * different decision from putting money in.
 */
export function WithdrawVault({
  vault,
  balance,
  isOwner,
  onChanged,
}: {
  vault: Address;
  balance: bigint | undefined;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const {address} = useActiveAddress();
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [localError, setLocalError] = useState<string | undefined>();
  const onDone = useCallback(() => {
    setAmount("");
    onChanged();
  }, [onChanged]);

  const withdraw = useOwnerWrite(onDone);

  if (!isOwner) return null;

  const to = recipient.trim() || address || "";
  const parsed = tryParseTusdt(amount);
  const error =
    !/^0x[0-9a-fA-F]{40}$/.test(to)
      ? "Recipient must be a valid address."
      : parsed === null || parsed <= 0n
        ? "Enter an amount greater than zero."
        : parsed > (balance ?? 0n)
          ? "More than the vault holds."
          : undefined;

  return (
    <div className="mt-5 border-t border-border pt-5">
      <h3 className="text-[13px] font-semibold text-text-primary">Withdraw (owner only)</h3>
      <p className="mt-0.5 text-[12px] text-text-muted">
        Moves funds out of Mandate. This cannot be undone from here.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setLocalError(undefined);
          if (error || parsed === null || parsed <= 0n) return;
          void withdraw.run({
            address: vault,
            abi: mandateVaultAbi,
            functionName: "withdrawToken",
            args: [TUSDT_ADDRESS, to as Address, parsed],
          });
        }}
      >
        <div className="min-w-[240px] flex-1">
          <Field label="Recipient" hint="Defaults to your connected wallet.">
            <TextInput
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder={address ?? "0x…"}
              className="font-mono"
            />
          </Field>
        </div>
        <div className="min-w-[140px]">
          <Field label="Amount (tUSDT)">
            <TextInput
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={!!error || withdraw.pending}>
          {withdraw.pending ? "Confirming..." : "Withdraw"}
        </Button>
      </form>
      {error && amount.trim() !== "" ? (
        <p className="mt-2 text-[12px] text-state-blocked">{error}</p>
      ) : null}
      {localError ? <p className="mt-2 text-[12px] text-state-blocked">{localError}</p> : null}
      {withdraw.error ? <p className="mt-2 text-[12px] text-state-blocked">{withdraw.error}</p> : null}
    </div>
  );
}

/** Shown when the connected wallet cannot act as owner at all. */
export function NoWalletNote() {
  return <PanelNote tone="error">Connect an external wallet to fund or withdraw.</PanelNote>;
}
