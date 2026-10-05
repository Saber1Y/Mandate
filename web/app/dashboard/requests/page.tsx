"use client";

import {useEffect, useMemo, useState} from "react";
import type {Address} from "viem";
import {mandateContracts, TUSDT_ADDRESS} from "@/lib/bot";
import {mandateVaultAbi} from "@/lib/abi/mandate";
import {publicClient} from "@/lib/chain";
import {
  formatTusdt,
  truncateAddress,
  truncateHash,
  timeAgo,
  isSameAddress,
} from "@/lib/format";
import {explorerTx} from "@/lib/chain";
import {useSpendHistory} from "@/lib/useChainRead";
import {useActiveAddress} from "@/lib/usePrivyWallet";
import {useRole} from "@/lib/useRole";
import {useOwnerWrite} from "@/lib/useOwnerWrite";
import {Panel, PanelNote} from "@/components/dashboard/Panel";
import {TxChip, Chip} from "@/components/ui/Chip";
import {Button} from "@/components/ui/Button";
import {PageLoader} from "@/components/ui/PageLoader";

/** Status index straight from MandateVault.RequestStatus. */
const STATUS = {
  none: 0,
  pending: 1,
  approved: 2,
  executed: 3,
  rejected: 4,
  expired: 5,
  cancelled: 6,
} as const;

const STATUS_LABEL: Record<number, string> = {
  0: "Unknown",
  1: "Pending",
  2: "Approved",
  3: "Executed",
  4: "Rejected",
  5: "Expired",
  6: "Cancelled",
};

interface RequestRow {
  requestId: `0x${string}`;
  agent: Address;
  token: Address;
  target: Address;
  amount: bigint;
  approvals: number;
  status: number;
  requestedAt: bigint;
  expiresAt: bigint;
  requestTxHash?: `0x${string}`;
  executeTxHash?: `0x${string}`;
}

/**
 * Request queue: approve, reject, cancel, and settle.
 *
 * This is the human side of the fence. Approval is a real owner-signed transaction, so nothing in
 * this UI can move funds without the organization wallet's key. Settlement is a separate step
 * because approval alone transfers nothing - the executor must still call `execute`, and the vault
 * re-validates the full policy at that moment.
 */
export default function RequestsPage() {
  const history = useSpendHistory({limit: 60});
  const {address} = useActiveAddress();
  const {isOwner, isApprover} = useRole();

  const requestedIds = useMemo(
    () => (history.data ?? []).filter((e) => e.kind === "requested"),
    [history.data],
  );
  const executed = useMemo(() => (history.data ?? []).filter((e) => e.kind === "executed"), [history.data]);

  const rows = useRequestRows(requestedIds, executed);

  if (history.loading) return <PageLoader label="Reading request events from BOT Chain..." fill />;

  const actionable = rows.filter((r) => r.status === STATUS.pending);
  const settled = rows.filter((r) => r.status !== STATUS.pending);
  const canApprove = isOwner || isApprover;

  return (
    <div className="p-6">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold text-text-primary tracking-tight">Requests</h1>
        <p className="mt-1 text-[13px] text-text-muted">
          Every row is read from the vault. Approval requires the organization wallet; settlement
          requires a registered executor.
        </p>
      </header>

      {!canApprove ? (
        <div className="mb-4 rounded-lg border border-border bg-surface-muted px-4 py-3 text-[12px] text-text-muted">
          You are not an approver on this vault, so approval and rejection are hidden. You can still
          see requests addressed to your own agent.
        </div>
      ) : null}

      <div className="grid gap-4">
        <Panel
          title="Awaiting decision"
          subtitle={`${actionable.length} pending`}
        >
          {actionable.length === 0 ? (
            <PanelNote>Nothing is waiting for approval.</PanelNote>
          ) : (
            <div className="space-y-3">
              {actionable.map((r) => (
                <RequestCard
                  key={r.requestId}
                  request={r}
                  canApprove={canApprove}
                  canCancel={isOwner || isSameAddress(r.agent, address)}
                  onChanged={history.refetch}
                />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Settled and closed" subtitle="Terminal requests, newest first">
          {settled.length === 0 ? (
            <PanelNote>No request has reached a terminal state yet.</PanelNote>
          ) : (
            <div className="space-y-2">
              {settled.map((r) => (
                <ClosedRow key={r.requestId} request={r} onChanged={history.refetch} />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function RequestCard({
  request,
  canApprove,
  canCancel,
  onChanged,
}: {
  request: RequestRow;
  canApprove: boolean;
  canCancel: boolean;
  onChanged: () => void;
}) {
  const approve = useOwnerWrite(onChanged);
  const reject = useOwnerWrite(onChanged);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("Rejected by policy owner");

  const expired = request.expiresAt !== 0n && Number(request.expiresAt) * 1000 < Date.now();

  return (
    <div className="rounded-lg border border-state-pending/30 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-text-primary tabular-nums">
              {formatTusdt(request.amount)} tUSDT
            </span>
            {expired ? <Chip tone="blush">past expiry</Chip> : null}
          </div>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
            <div>
              <dt className="text-text-muted">Agent</dt>
              <dd className="font-mono text-text-primary">{truncateAddress(request.agent)}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Recipient</dt>
              <dd className="font-mono text-text-primary">{truncateAddress(request.target)}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Approvals</dt>
              <dd className="text-text-primary tabular-nums">{request.approvals}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Expires</dt>
              <dd className="text-text-primary">
                {request.expiresAt === 0n ? "no expiry" : timeAgo(Number(request.expiresAt))}
              </dd>
            </div>
          </dl>
          <div className="mt-2">
            <dt className="text-[12px] text-text-muted">Request id</dt>
            <dd className="font-mono text-[11px] text-text-primary break-all">{request.requestId}</dd>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          {canApprove ? (
            <>
              <Button
                size="sm"
                disabled={approve.pending || expired}
                onClick={() =>
                  approve.run({
                    address: mandateContracts().vault,
                    abi: mandateVaultAbi,
                    functionName: "approve",
                    args: [request.requestId],
                  })
                }
              >
                {approve.pending ? "Approving..." : "Approve"}
              </Button>
              {!rejecting ? (
                <Button size="sm" variant="ghost" onClick={() => setRejecting(true)}>
                  Reject
                </Button>
              ) : (
                <div className="flex flex-col items-stretch gap-1.5">
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason recorded on-chain"
                    className="w-[220px] rounded-lg border border-border px-2.5 py-1.5 text-[12px] outline-none focus:border-accent"
                  />
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={reject.pending}
                      onClick={() =>
                        reject.run({
                          address: mandateContracts().vault,
                          abi: mandateVaultAbi,
                          functionName: "reject",
                          args: [request.requestId, reason || "Rejected"],
                        })
                      }
                    >
                      {reject.pending ? "Rejecting..." : "Confirm reject"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
                      Back
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <span className="text-[11px] text-text-muted">approver only</span>
          )}
          {canCancel ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                approve.run({
                  address: mandateContracts().vault,
                  abi: mandateVaultAbi,
                  functionName: "cancel",
                  args: [request.requestId],
                })
              }
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {approve.error ? <p className="mt-2 text-[12px] text-state-blocked">{approve.error}</p> : null}
      {reject.error ? <p className="mt-2 text-[12px] text-state-blocked">{reject.error}</p> : null}
    </div>
  );
}

function ClosedRow({request, onChanged}: {request: RequestRow; onChanged: () => void}) {
  const execute = useOwnerWrite(onChanged);
  const executedNow = request.status === STATUS.executed;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-white px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-text-primary tabular-nums">
            {formatTusdt(request.amount)} tUSDT
          </span>
          <Chip tone={executedNow ? "mint" : "blush"}>{STATUS_LABEL[request.status] ?? "Unknown"}</Chip>
        </div>
        <div className="mt-0.5 text-[11px] text-text-muted">
          agent {truncateAddress(request.agent)} → {truncateAddress(request.target)}
          {request.requestedAt ? ` · ${timeAgo(Number(request.requestedAt))}` : ""}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {request.executeTxHash ? (
          <TxChip href={explorerTx(request.executeTxHash)} label={truncateHash(request.executeTxHash)} tone="mint" />
        ) : request.requestTxHash ? (
          <TxChip href={explorerTx(request.requestTxHash)} label={truncateHash(request.requestTxHash)} />
        ) : null}
        {request.status === STATUS.approved ? (
          <Button
            size="sm"
            disabled={execute.pending}
            onClick={() =>
              execute.run({
                address: mandateContracts().vault,
                abi: mandateVaultAbi,
                functionName: "execute",
                args: [request.requestId],
              })
            }
          >
            {execute.pending ? "Settling..." : "Settle now"}
          </Button>
        ) : null}
        {execute.error ? <span className="text-[11px] text-state-blocked">{execute.error}</span> : null}
      </div>
    </div>
  );
}

/**
 * Reconcile request events into current rows.
 *
 * The last event seen for a request id wins for its transaction hash, and `getRequest` supplies
 * authoritative status. This matters because a request can be requested, approved, and executed
 * within one refresh window; the final chain state always overrides the event narrative.
 */
function useRequestRows(
  requested: {requestId: `0x${string}`; txHash: `0x${string}`; blockNumber: bigint}[],
  executed: {requestId: `0x${string}`; txHash: `0x${string}`; blockNumber: bigint}[],
): RequestRow[] {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);

  const signature = useMemo(
    () =>
      JSON.stringify({
        requested: requested.map((r) => `${r.requestId}:${r.txHash}`).sort(),
        executed: executed.map((r) => `${r.requestId}:${r.txHash}`).sort(),
      }),
    [requested, executed],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const parsed = JSON.parse(signature) as {
      requested: [string, string][];
      executed: [string, string][];
    };

    const byId = new Map<string, RequestRow>();
    for (const [requestId, txHash] of parsed.requested) {
      byId.set(requestId, {
        requestId: requestId as `0x${string}`,
        agent: "0x0000000000000000000000000000000000000000",
        token: TUSDT_ADDRESS,
        target: "0x0000000000000000000000000000000000000000",
        amount: 0n,
        approvals: 0,
        status: STATUS.none,
        requestedAt: 0n,
        expiresAt: 0n,
        requestTxHash: txHash as `0x${string}`,
      });
    }
    for (const [requestId, txHash] of parsed.executed) {
      const existing = byId.get(requestId);
      if (existing) {
        existing.executeTxHash = txHash as `0x${string}`;
        existing.status = STATUS.executed;
      }
    }

    async function resolve() {
      const {vault} = mandateContracts();
      for (const row of byId.values()) {
        if (cancelled) return;
        try {
          const onChain = await publicClient.readContract({
            address: vault,
            abi: mandateVaultAbi,
            functionName: "getRequest",
            args: [row.requestId],
          });
          row.agent = onChain.agent;
          row.token = onChain.token;
          row.target = onChain.target;
          row.amount = onChain.amount;
          row.approvals = Number(onChain.approvals);
          row.status = Number(onChain.status);
          row.requestedAt = onChain.requestedAt;
          row.expiresAt = onChain.expiresAt;
        } catch {
          // Skip ids the chain does not know.
          byId.delete(row.requestId);
        }
      }
      if (cancelled) return;
      setRows([...byId.values()]);
      setLoading(false);
    }

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [signature]);

  if (loading) return [];
  return rows;
}