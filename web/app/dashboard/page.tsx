"use client";

import {useCallback, useEffect, useMemo, useState} from "react";
import Link from "next/link";
import type {Address} from "viem";
import {TUSDT_ADDRESS, TUSDT_DECIMALS, BOT_RPC_URL} from "@/lib/bot";
import {mandateVaultAbi} from "@/lib/abi/mandate";
import {requestStatusName} from "@/lib/contracts";
import {publicClient} from "@/lib/chain";
import {isSameAddress, formatTusdt, truncateAddress, truncateHash, timeAgo} from "@/lib/format";
import {explorerAddress, explorerTx} from "@/lib/chain";
import {useTreasuryState, useSpendHistory, useAgentBudget} from "@/lib/useChainRead";
import {useActiveAddress, usePrivyWalletClient} from "@/lib/usePrivyWallet";
import {useRole} from "@/lib/useRole";
import {useVault} from "@/lib/useVault";
import {useOwnerWrite} from "@/lib/useOwnerWrite";
import {Panel, PanelNote} from "@/components/dashboard/Panel";
import {FundVault, WithdrawVault} from "@/components/dashboard/FundVault";
import {DailyCapMeter} from "@/components/dashboard/DailyCapMeter";
import {Card} from "@/components/ui/Card";
import {StatTile} from "@/components/ui/StatTile";
import {TxChip, CopyChip} from "@/components/ui/Chip";
import {EmptyState} from "@/components/ui/EmptyState";
import {Skeleton} from "@/components/ui/Row";
import {PageLoader} from "@/components/ui/PageLoader";

/** Pending requests awaiting approval, derived from SpendRequested events. */
interface PendingRequest {
  requestId: `0x${string}`;
  agent: Address;
  target: Address;
  token: Address;
  amount: bigint;
  expiresAt: bigint;
  txHash: `0x${string}`;
}

/**
 * Operator overview.
 *
 * Everything here is a live contract read. The owner never sees a server-rendered balance, because
 * there is no server-side copy of one: the vault is the only ledger, so the dashboard and the
 * settlement path cannot disagree.
 */
export default function DashboardPage() {
  const {vault} = useVault();
  const treasury = useTreasuryState(vault);
  const history = useSpendHistory({vault, limit: 25});
  const {address} = useActiveAddress();
  const {isOwner, isApprover} = useRole();

  // Per-user state. The treasury tiles below are shared public facts and deliberately identical for
  // everyone, but authority and budget are not: they are resolved against the connected address, so
  // switching wallets must change what this page claims about you.
  const mine = useAgentBudget(vault, address);

  const pending = usePendingRequests(vault);
  const settled = useMemo(
    () => (history.data ?? []).filter((e) => e.kind === "executed").slice(0, 6),
    [history.data],
  );
  const approvedCount = useMemo(
    () => (history.data ?? []).filter((e) => e.kind === "executed").length,
    [history.data],
  );

  const myRequests = useMemo(
    () => (history.data ?? []).filter((e) => isSameAddress(e.agent, address)),
    [history.data, address],
  );

  const role = !address
    ? undefined
    : isOwner
      ? "Owner"
      : isApprover
        ? "Approver"
        : mine.data?.registered
          ? "Agent"
          : "Viewer";

  if (treasury.loading) return <PageLoader label="Reading the vault on BOT Chain..." fill />;

  if (treasury.error || !treasury.data) {
    return (
      <div className="p-6">
        <Panel title="Vault unavailable" subtitle="The chain read did not return a vault.">
          <PanelNote tone="error">{treasury.error ?? "No vault state."}</PanelNote>
        </Panel>
      </div>
    );
  }

  const t = treasury.data;

  return (
    <div className="p-6">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold text-text-primary tracking-tight">Overview</h1>
        <p className="mt-1 text-[13px] text-text-muted">
          Live treasury state read from BOT Chain testnet.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card tone="paper" pad="md">
          <StatTile
            label="Total controlled"
            value={`$${formatTusdt(t.treasuryBalance)}`}
            sub={<span className="text-text-muted">tUSDT in the vault</span>}
          />
        </Card>
        <Card tone="paper" pad="md">
          <StatTile
            label="Spent today"
            value={`$${formatTusdt(mine.data?.policy.spentToday ?? 0n)}`}
            sub={
              <span className="text-text-muted">
                {mine.data ? `of $${formatTusdt(mine.data.policy.dailyCap)} daily cap` : "for your address"}
              </span>
            }
          />
        </Card>
        <Card tone="paper" pad="md">
          <StatTile
            label="Remaining today"
            value={`$${formatTusdt(mine.data?.remainingDailyCap ?? 0n)}`}
            sub={<span className="text-text-muted">your address&rsquo;s headroom</span>}
          />
        </Card>
        <Card tone="paper" pad="md">
          <StatTile
            label="Approved"
            value={approvedCount}
            sub={<span className="text-text-muted">settlements on chain</span>}
          />
        </Card>
        <Card tone="paper" pad="md">
          <StatTile
            label="Awaiting approval"
            value={pending.data?.length ?? "-"}
            sub={
              <span className="text-text-muted">
                {pending.data?.length ? "needs an approver" : "queue is clear"}
              </span>
            }
          />
        </Card>
        <Card tone="paper" pad="md">
          <StatTile
            label="Settlement token"
            value={<span className="text-[15px]">tUSDT</span>}
            sub={<CopyChip value={TUSDT_ADDRESS} label={truncateAddress(TUSDT_ADDRESS)} />}
          />
        </Card>
        <Card tone="paper" pad="md">
          <StatTile
            label="Vault state"
            value={
              t.paused ? (
                <span className="text-state-blocked">Paused</span>
              ) : (
                <span className="text-state-approved">Active</span>
              )
            }
            sub={<span className="text-text-muted">owner controls pause</span>}
          />
        </Card>
      </div>

      {/* Funding comes before anything else an operator does: an empty vault cannot spend. */}
      <div className="mt-4">
        <FundVault
          vault={vault!}
          vaultBalance={t.treasuryBalance}
          onChanged={treasury.refetch}
        />
        <Panel title="Treasury exit" subtitle="Owner authority" className="mt-4">
          <WithdrawVault
            vault={vault!}
            balance={t.treasuryBalance}
            isOwner={isOwner}
            onChanged={treasury.refetch}
          />
        </Panel>
      </div>

      <div className="mt-4">
        <Panel
          title="Your access"
          subtitle="Resolved against the connected wallet on every wallet change"
        >
          {!address ? (
            <PanelNote>Connect a wallet to see the authority this vault grants you.</PanelNote>
          ) : (
            <>
              <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Detail label="Connected wallet" href={explorerAddress(address)}>
                  {address}
                </Detail>
                <Detail label="Role on this vault">{role}</Detail>
                <Detail label="Your requests">{myRequests.length}</Detail>
                <Detail label="Vault owner">{truncateAddress(t.vaultOwner)}</Detail>
              </dl>

              {mine.data?.registered ? (
                <div className="mt-4 border-t border-border pt-4">
                  <div className="mb-3 flex items-baseline justify-between gap-3">
                    <h2 className="text-[13px] font-medium text-text-primary">
                      Your spending budget
                    </h2>
                    <span className="text-[11px] text-text-muted">
                      the vault enforces these, not this page
                    </span>
                  </div>
                  <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Detail label="Max per request">{formatTusdt(mine.data.policy.maxPerTx)} tUSDT</Detail>
                    <Detail label="Daily cap">{formatTusdt(mine.data.policy.dailyCap)} tUSDT</Detail>
                    <Detail label="Spent today">{formatTusdt(mine.data.policy.spentToday)} tUSDT</Detail>
                    <Detail label="Remaining today">
                      {formatTusdt(mine.data.remainingDailyCap)} tUSDT
                    </Detail>
                    <Detail label="Approvals required">
                      {mine.data.policy.approvalThreshold === 0
                        ? "none (auto-approved)"
                        : String(mine.data.policy.approvalThreshold)}
                    </Detail>
                    <Detail label="tUSDT settlement">{mine.data.tokenAllowed ? "Allowed" : "Blocked"}</Detail>
                    <Detail label="Policy status">
                      {mine.data.policy.active ? "Active" : "Paused"}
                    </Detail>
                    <Detail label="Policy expires">
                      {mine.data.policy.expiry === 0n
                        ? "never"
                        : new Date(Number(mine.data.policy.expiry) * 1000).toLocaleString()}
                    </Detail>
                  </dl>
                  <div className="mt-3">
                    <DailyCapMeter
                      spent={mine.data.policy.spentToday}
                      cap={mine.data.policy.dailyCap}
                      remaining={mine.data.remainingDailyCap}
                    />
                  </div>
                </div>
              ) : mine.loading ? (
                <div className="mt-4 border-t border-border pt-4">
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : (
                <p className="mt-4 border-t border-border pt-4 text-[12px] text-text-muted">
                  {role === "Viewer"
                    ? "This address has no policy on this vault, so it cannot request a spend. That is the default for every new address."
                    : "You have treasury authority rather than a spending budget. Authority is decided by the vault owner, not by an agent policy."}
                </p>
              )}
            </>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel
          title="Awaiting approval"
          subtitle="SpendRequested events with no approval yet"
          action={
            pending.data && pending.data.length > 0 ? (
              <Link href="/dashboard/requests" className="text-[12px] font-medium text-accent hover:underline">
                Review all
              </Link>
            ) : null
          }
        >
          {pending.loading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !pending.data || pending.data.length === 0 ? (
            <PanelNote>
              No requests are waiting. An agent&rsquo;s request appears here the moment it is
              submitted on-chain.
            </PanelNote>
          ) : (
            <div className="space-y-2">
              {pending.data.slice(0, 5).map((r) => (
                <PendingRow
                  key={r.requestId}
                  vault={vault!}
                  request={r}
                  canAct={isOwner || isApprover}
                  isMe={isSameAddress(r.agent, address)}
                  onSettled={pending.refresh}
                />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Recent decisions" subtitle="Settled on chain, and refused by policy">
          {history.loading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : settled.length === 0 ? (
            <PanelNote>
              Nothing yet. A settled spend appears here from the chain; a refused one appears with the
              reason the vault gave.
            </PanelNote>
          ) : (
            <div className="space-y-2">
              {settled.map((e) => (
                <div key={`${e.txHash}-${e.kind}`} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-white px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-text-primary tabular-nums">
                      {formatTusdt(e.amount)} tUSDT
                    </div>
                    <div className="mt-0.5 text-[11px] text-text-muted">
                      to {truncateAddress(e.target)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium text-state-approved">Approved</span>
                    <TxChip href={explorerTx(e.txHash)} label={truncateHash(e.txHash)} tone="mint" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title="Deployment" subtitle="Where this dashboard is pointed">
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Detail label="Vault" href={explorerAddress(t.vault)}>
              {t.vault}
            </Detail>
            <Detail label="Owner (org wallet)" href={explorerAddress(t.vaultOwner)}>
              {t.vaultOwner}
            </Detail>
            <Detail label="RPC">{BOT_RPC_URL}</Detail>
            <Detail label="Decimals">{String(TUSDT_DECIMALS)}</Detail>
          </dl>
        </Panel>
      </div>
    </div>
  );
}

function PendingRow({
  vault,
  request,
  canAct,
  isMe,
  onSettled,
}: {
  vault: Address;
  request: PendingRequest;
  canAct: boolean;
  isMe: boolean;
  onSettled: () => void;
}) {
  // Refetch the live pending set after the write so the row only clears because the chain says so.
  const {run, pending: submitting, error} = useOwnerWrite(onSettled);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div className="rounded-lg border border-state-approved/30 bg-state-approved-light px-4 py-3 text-[12px] text-state-approved">
        {canAct ? "Approved. The executor can settle it." : "Approved by the vault owner."}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-state-pending/25 bg-state-pending-light/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-text-primary tabular-nums">
            {formatTusdt(request.amount)} tUSDT
          </div>
          <div className="mt-0.5 text-[11px] text-text-muted">
            agent {truncateAddress(request.agent)} → {truncateAddress(request.target)}
          </div>
          <div className="mt-0.5 text-[11px] text-text-muted">
            expires {request.expiresAt === 0n ? "never" : timeAgo(Number(request.expiresAt))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <TxChip href={explorerTx(request.txHash)} label={truncateHash(request.txHash)} />
          {canAct ? (
            <button
              disabled={submitting}
              onClick={async () => {
                const ok = await run({
                  address: vault,
                  abi: mandateVaultAbi,
                  functionName: "approve",
                  args: [request.requestId],
                });
                if (ok) setDone(true);
              }}
              className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
            >
              {submitting ? "Approving..." : "Approve"}
            </button>
          ) : (
            <span className="text-[11px] text-text-muted">{isMe ? "your request" : "owner only"}</span>
          )}
        </div>
      </div>
      {error ? <p className="mt-2 text-[11px] text-state-blocked">{error}</p> : null}
    </div>
  );
}

function Detail({label, children, href}: {label: string; children: React.ReactNode; href?: string}) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="mt-1 break-all text-[12px] text-text-primary">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-accent hover:underline">
            {truncateAddress(children as string)}
          </a>
        ) : (
          children
        )}
      </dd>
    </div>
  );
}

/**
 * Pending requests are derived from SpendRequested minus anything that later advanced.
 *
 * There is no `getRequests()` enumeration on the contract, so an indexer would be the fix at
 * production volume. For the testnet console this reads the recent window and reconciles each id
 * against `getRequest`, which is exact for that window without inventing state.
 */
function usePendingRequests(vault?: Address): {data?: PendingRequest[]; loading: boolean; refresh: () => void} {
  const history = useSpendHistory({vault, limit: 50});
  const [pending, setPending] = useState<PendingRequest[] | undefined>(undefined);

  const requested = useMemo(
    () => (history.data ?? []).filter((e) => e.kind === "requested"),
    [history.data],
  );

  useEffect(() => {
    let cancelled = false;
    if (history.loading) return;
    // No vault means no history to reconcile. Settle to an empty list rather than leaving the
    // panel in its skeleton state forever.
    if (!vault || requested.length === 0) {
      setPending([]);
      return;
    }
    // Narrowed once, outside the async closure.
    const treasury: Address = vault;

    async function resolve() {
      const resolved: PendingRequest[] = [];
      for (const e of requested) {
        if (cancelled) return;
        try {
          const onChain = await publicClient.readContract({
            address: treasury,
            abi: mandateVaultAbi,
            functionName: "getRequest",
            args: [e.requestId],
          });
          // Only Pending still needs an approval. Compare against the named status, not 1, so a
          // future enum insertion cannot silently turn this into "show executed requests".
          if (requestStatusName(onChain.status) === "Pending") {
            resolved.push({
              requestId: e.requestId,
              agent: onChain.agent,
              target: onChain.target,
              token: onChain.token,
              amount: onChain.amount,
              expiresAt: onChain.expiresAt,
              txHash: e.txHash,
            });
          }
        } catch {
          // Unknown id: not actionable.
        }
      }
      if (!cancelled) setPending(resolved);
    }

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [requested, history.loading, vault]);

  const refresh = useCallback(() => {
    setPending(undefined);
    void history.refetch();
  }, [history]);

  return {data: pending, loading: history.loading || pending === undefined, refresh};
}
