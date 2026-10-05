"use client";

import {useCallback, useEffect, useState} from "react";
import {BOT_CHAIN_ID, BOT_EXPLORER_URL, mandateFactory} from "@/lib/bot";
import {mandateVaultFactoryAbi} from "@/lib/abi/mandate";
import {tryParseTusdt, truncateAddress} from "@/lib/format";
import {usePrivyWalletClient} from "@/lib/usePrivyWallet";
import {useOwnerWrite} from "@/lib/useOwnerWrite";
import {useVault} from "@/lib/useVault";
import {Panel} from "@/components/dashboard/Panel";
import {Button} from "@/components/ui/Button";
import {Field, TextInput} from "@/components/ui/Input";

/**
 * Onboarding for an address that owns no vault yet.
 *
 * Mandate is one vault per organization. `createVault` is the only moment a treasury comes into
 * existence, and it is irreversible: the caller becomes the owner and cannot be changed afterwards.
 * That makes the leash parameters - per-tx limit, daily cap, approval threshold, expiry - the
 * first decision an organization makes about its own risk posture, so they are surfaced here with
 * plain consequences instead of being defaulted silently inside the contract.
 *
 * Nothing is submitted until the connected wallet is confirmed on-chain to have no vault, so a
 * duplicate submission reverts with VaultAlreadyExists rather than creating a surprise second
 * treasury.
 */
export function Onboarding() {
  const {vault, checked, refetch} = useVault();
  const {getClient} = usePrivyWalletClient();

  const [maxPerTx, setMaxPerTx] = useState("100");
  const [dailyCap, setDailyCap] = useState("1000");
  const [threshold, setThreshold] = useState("1");
  const [expiryDays, setExpiryDays] = useState("0");
  const [setupError, setSetupError] = useState<string | undefined>();

  // Once a vault exists for this address, hand control back to the dashboard.
  useEffect(() => {
    if (vault) refetch();
  }, [vault, refetch]);

  const onCreated = useCallback(() => refetch(), [refetch]);
  const create = useOwnerWrite(onCreated);

  // Surface wallet-connection problems before the user fills in a form they cannot submit.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const client = await getClient();
        if (!cancelled && !client) setSetupError("Connect an external wallet to create a treasury.");
      } catch {
        if (!cancelled) setSetupError("Connect an external wallet to create a treasury.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getClient]);

  if (vault) return null;

  // Parse and validate locally so an obviously bad leash never costs a wallet signature. The
  // contract is still the authority; this only spares the user a reverting transaction.
  //
  // Parsing must not throw here: this runs during render, so an empty or partially typed field
  // would otherwise take down the whole onboarding screen instead of showing a validation message.
  const maxTxBase = tryParseTusdt(maxPerTx);
  const capBase = tryParseTusdt(dailyCap);
  const thresholdValue = Number(threshold) || 0;
  const days = Number(expiryDays) || 0;

  const leashError =
    maxTxBase === null || maxTxBase <= 0n
      ? "Max per transaction must be a positive number of tUSDT."
      : capBase === null || capBase <= 0n
        ? "Daily cap must be a positive number of tUSDT."
        : maxTxBase > capBase
          ? "Max per transaction cannot exceed the daily cap."
          : thresholdValue < 1 || thresholdValue > 3
            ? "Approvals needed must be between 1 and 3."
            : days < 0 || !Number.isFinite(days)
              ? "Expiry cannot be negative."
              : undefined;

  const expiryTimestamp = days > 0 ? BigInt(Math.floor(Date.now() / 1000) + days * 86400) : 0n;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted p-6">
      <div className="w-full max-w-lg">
        <div className="mb-6 text-center">
          <span className="text-md font-semibold text-white tracking-tight">Mandate</span>
          <h1 className="mt-3 text-[20px] font-semibold text-text-primary tracking-tight">
            Create your treasury
          </h1>
          <p className="mt-1.5 text-[13px] text-text-muted">
            One vault per address, created by you and owned by you. Set the limits your agents are
            held to.
          </p>
        </div>

        <Panel title="Vault leash" subtitle="Applies to every agent in this treasury">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              // `leashError` already encodes both parse failures, but narrowing has to be explicit
              // here because it is what makes the args well-typed rather than bigint | null.
              if (leashError || !checked || maxTxBase === null || capBase === null) return;
              void create.run({
                address: mandateFactory(),
                abi: mandateVaultFactoryAbi,
                functionName: "createVault",
                args: [maxTxBase, capBase, expiryTimestamp, thresholdValue],
              });
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Max per transaction (tUSDT)">
                <TextInput
                  value={maxPerTx}
                  onChange={(e) => setMaxPerTx(e.target.value)}
                  inputMode="decimal"
                />
              </Field>
              <Field label="Daily cap (tUSDT)">
                <TextInput
                  value={dailyCap}
                  onChange={(e) => setDailyCap(e.target.value)}
                  inputMode="decimal"
                />
              </Field>
              <Field label="Approvals needed" hint="1 to 3. Above 1 needs a multi-approver org.">
                <TextInput
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  inputMode="numeric"
                />
              </Field>
              <Field label="Policy expiry (days, 0 = never)">
                <TextInput
                  value={expiryDays}
                  onChange={(e) => setExpiryDays(e.target.value)}
                  inputMode="numeric"
                />
              </Field>
            </div>

            {leashError ? <p className="text-[12px] text-state-blocked">{leashError}</p> : null}
            {setupError ? <p className="text-[12px] text-state-blocked">{setupError}</p> : null}
            {create.error ? <p className="text-[12px] text-state-blocked">{create.error}</p> : null}

            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <p className="text-[11px] text-text-muted">
                Creates a vault on chain {BOT_CHAIN_ID} owned permanently by this wallet.
              </p>
              <Button type="submit" disabled={!!leashError || create.pending || !checked}>
                {create.pending ? "Confirming..." : "Create treasury"}
              </Button>
            </div>
          </form>
        </Panel>

        <p className="mt-4 text-center text-[11px] text-text-muted">
          Factory{" "}
          <a
            href={`${BOT_EXPLORER_URL}/address/${mandateFactory()}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-accent hover:underline"
          >
            {truncateAddress(mandateFactory())}
          </a>
        </p>
      </div>
    </div>
  );
}