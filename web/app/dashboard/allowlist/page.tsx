"use client";

import {useEffect, useState} from "react";
import {isAddress, type Address} from "viem";
import {CONTRACTS, vaultAbi} from "@/lib/contracts";
import {useVaultState, useApiAgents} from "@/lib/hooks";
import {isSameAddress, truncateAddress} from "@/lib/format";
import {useActiveAddress} from "@/lib/usePrivyWallet";
import {useOwnerWrite} from "@/lib/useOwnerWrite";

/** Parse a USD budget string (e.g. "2.5") into raw USDC base units, or null when blank/invalid. */
function parseBudget(v: string): number | null {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n * 1_000_000);
}

function RecipientSection({isOwner, agent, refetch}: {
  isOwner: boolean;
  agent: Address;
  refetch: () => void;
}) {
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [maxPerTx, setMaxPerTx] = useState("");
  const [dailyCap, setDailyCap] = useState("");
  const [onchainMaxPerTx, setOnchainMaxPerTx] = useState("");
  const [onchainDailyCap, setOnchainDailyCap] = useState("");
  const write = useOwnerWrite(refetch);
  const [apiRecipients, setApiRecipients] = useState<{id: number; address: string; label: string; max_per_tx_usdc: number | null; daily_cap_usdc: number | null}[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/allowlist/${agent}`)
      .then((r) => r.json())
      .then((d) => setApiRecipients(d.recipients ?? []))
      .catch(() => {});
  }, [agent]);

  const addApiRecipient = async () => {
    if (!isAddress(target)) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/allowlist/${agent}`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
          type: "recipient",
          address: target,
          label,
          maxPerTxUsdc: parseBudget(maxPerTx),
          dailyCapUsdc: parseBudget(dailyCap),
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to add");
      } else {
        const d = await res.json();
        setApiRecipients((prev) => [...prev, d.entry]);
        setTarget("");
        setLabel("");
        setMaxPerTx("");
        setDailyCap("");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeApiRecipient = async (id: number) => {
    try {
      await fetch(`/api/allowlist/${agent}`, {
        method: "DELETE",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({id}),
      });
      setApiRecipients((prev) => prev.filter((r) => r.id !== id));
    } catch {}
  };

  return (
    <div className="kpi-card p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-[13px] font-semibold text-text-primary">Allowed Recipients</div>
          <div className="text-[12px] text-text-muted mt-0.5">Addresses the agent is permitted to send payments to</div>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <div className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">Server-Side (API)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-[11px] font-medium text-text-muted uppercase tracking-wider">Address</th>
                  <th className="text-left py-2 px-3 text-[11px] font-medium text-text-muted uppercase tracking-wider">Label</th>
                  <th className="text-left py-2 px-3 text-[11px] font-medium text-text-muted uppercase tracking-wider">Per-Tx Budget</th>
                  <th className="text-left py-2 px-3 text-[11px] font-medium text-text-muted uppercase tracking-wider">Daily Budget</th>
                  <th className="text-right py-2 px-3 text-[11px] font-medium text-text-muted uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {apiRecipients.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-[12px] text-text-muted">
                      No recipients allowlisted in API.
                    </td>
                  </tr>
                ) : (
                  apiRecipients.map((r) => (
                    <tr key={r.id} className="hover:bg-surface-hover/50">
                      <td className="py-2 px-3 font-mono text-text-primary text-[12px]">{truncateAddress(r.address as `0x${string}`)}</td>
                      <td className="py-2 px-3 text-text-muted text-[12px]">{r.label || "-"}</td>
                      <td className="py-2 px-3 text-text-muted text-[12px]">
                        {r.max_per_tx_usdc != null ? `$${(r.max_per_tx_usdc / 1e6).toFixed(2)}` : "unlimited"}
                      </td>
                      <td className="py-2 px-3 text-text-muted text-[12px]">
                        {r.daily_cap_usdc != null ? `$${(r.daily_cap_usdc / 1e6).toFixed(2)}/day` : "unlimited"}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <button onClick={() => removeApiRecipient(r.id)} className="text-[12px] text-state-blocked hover:underline">
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_110px_110px_110px_auto]">
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="0x..."
              className="rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary font-mono outline-none focus:border-accent"
              spellCheck={false}
            />
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label"
              className="rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
            />
            <input
              value={maxPerTx}
              onChange={(e) => setMaxPerTx(e.target.value)}
              placeholder="$/tx"
              inputMode="decimal"
              className="rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
            />
            <input
              value={dailyCap}
              onChange={(e) => setDailyCap(e.target.value)}
              placeholder="$/day"
              inputMode="decimal"
              className="rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
            />
            <button
              onClick={addApiRecipient}
              disabled={!isAddress(target) || saving}
              className="rounded-lg bg-accent px-4 py-2 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              Add
            </button>
          </div>
          {error && <div className="text-[12px] text-state-blocked mt-2">{error}</div>}
        </div>

        <div className="pt-4 border-t border-border">
          <div className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">On-Chain (Vault)</div>
          {isOwner ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_100px_100px_auto]">
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="0x..."
                className="rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary font-mono outline-none focus:border-accent"
                spellCheck={false}
              />
              <input
                value={onchainMaxPerTx}
                onChange={(e) => setOnchainMaxPerTx(e.target.value)}
                placeholder="$/tx"
                inputMode="decimal"
                className="rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
              />
              <input
                value={onchainDailyCap}
                onChange={(e) => setOnchainDailyCap(e.target.value)}
                placeholder="$/day"
                inputMode="decimal"
                className="rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
              />
              <button
                onClick={() => {
                  if (!isAddress(target)) return;
                  write.run({
                    address: CONTRACTS.vault,
                    abi: vaultAbi,
                    functionName: "setAllowedService",
                    args: [
                      agent,
                      target as Address,
                      label || "service",
                      BigInt(parseBudget(onchainMaxPerTx) ?? 0),
                      BigInt(parseBudget(onchainDailyCap) ?? 0),
                      0n,
                      true,
                    ],
                  });
                }}
                disabled={!isAddress(target) || write.pending}
                className="rounded-lg bg-accent px-4 py-2 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                Add On-Chain
              </button>
            </div>
          ) : (
            <div className="text-[12px] text-text-muted">Connect owner wallet to manage on-chain allowlist.</div>
          )}
          {write.error && <div className="text-[12px] text-state-blocked mt-2">{write.error}</div>}
        </div>
      </div>
    </div>
  );
}

function TokenSection({isOwner, agent}: {
  isOwner: boolean;
  agent: Address;
}) {
  const [token, setToken] = useState<string>(CONTRACTS.usdc);
  const write = useOwnerWrite(() => {});
  const [apiTokens, setApiTokens] = useState<{id: number; address: string; label: string}[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/allowlist/${agent}`)
      .then((r) => r.json())
      .then((d) => setApiTokens(d.tokens ?? []))
      .catch(() => {});
  }, [agent]);

  const addApiToken = async () => {
    if (!isAddress(token)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/allowlist/${agent}`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({type: "token", address: token, label: "USDC"}),
      });
      if (res.ok) {
        const d = await res.json();
        setApiTokens((prev) => [...prev, d.entry]);
      }
    } catch {} finally { setSaving(false); }
  };

  const removeApiToken = async (id: number) => {
    try {
      await fetch(`/api/allowlist/${agent}`, {
        method: "DELETE",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({id}),
      });
      setApiTokens((prev) => prev.filter((t) => t.id !== id));
    } catch {}
  };

  return (
    <div className="kpi-card p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-[13px] font-semibold text-text-primary">Allowed Tokens</div>
          <div className="text-[12px] text-text-muted mt-0.5">ERC-20 tokens the agent is permitted to spend</div>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <div className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">Server-Side (API)</div>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-[11px] font-medium text-text-muted uppercase tracking-wider">Symbol</th>
                <th className="text-left py-2 px-3 text-[11px] font-medium text-text-muted uppercase tracking-wider">Address</th>
                <th className="text-right py-2 px-3 text-[11px] font-medium text-text-muted uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {apiTokens.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-4 text-center text-[12px] text-text-muted">
                    No tokens allowlisted.
                  </td>
                </tr>
              ) : (
                apiTokens.map((t) => (
                  <tr key={t.id} className="hover:bg-surface-hover/50">
                    <td className="py-2 px-3 font-medium text-text-primary text-[12px]">{t.label || "Token"}</td>
                    <td className="py-2 px-3 font-mono text-text-muted text-[12px]">{truncateAddress(t.address as `0x${string}`)}</td>
                    <td className="py-2 px-3 text-right">
                      <button onClick={() => removeApiToken(t.id)} className="text-[12px] text-state-blocked hover:underline">
                        Remove
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <div className="mt-3 flex gap-2">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="0x..."
              className="flex-1 rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary font-mono outline-none focus:border-accent"
              spellCheck={false}
            />
            <button
              onClick={addApiToken}
              disabled={!isAddress(token) || saving}
              className="rounded-lg bg-accent px-4 py-2 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>

        <div className="pt-4 border-t border-border">
          <div className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">On-Chain (Vault)</div>
          {isOwner ? (
            <div className="flex gap-2">
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="0x..."
                className="flex-1 rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary font-mono outline-none focus:border-accent"
                spellCheck={false}
              />
              <button
                onClick={() => {
                  if (!isAddress(token)) return;
                  write.run({address: CONTRACTS.vault, abi: vaultAbi, functionName: "setAllowedToken", args: [agent, token as Address, true]});
                }}
                disabled={!isAddress(token) || write.pending}
                className="rounded-lg bg-accent px-4 py-2 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                Add On-Chain
              </button>
            </div>
          ) : (
            <div className="text-[12px] text-text-muted">Connect owner wallet to manage on-chain allowlist.</div>
          )}
          {write.error && <div className="text-[12px] text-state-blocked mt-2">{write.error}</div>}
        </div>
      </div>
    </div>
  );
}

export default function AllowlistPage() {
  const {agents} = useApiAgents();
  const agentAddress = (agents[0]?.address ?? "0x3F5b96A494061F7338Da529e3047809Ac6a7FB84") as Address;
  const agentId = agents[0]?.id ?? "";
  const {data: state, refetch} = useVaultState(agentAddress, CONTRACTS.vault);
  const {address, isConnected} = useActiveAddress();
  const isOwner = isConnected && !!state && isSameAddress(address, state.vaultOwner);

  return (
    <div className="p-8 max-w-[1200px] mx-auto">
      <div className="mb-6" data-aos="fade-up">
        <h1 className="text-[20px] font-semibold text-text-primary tracking-tight">Allowlist</h1>
        <p className="text-[13px] text-text-muted mt-1">Access control management for agent spending</p>
      </div>

      {!isOwner && isConnected && (
        <div className="mb-6 rounded-lg border border-state-pending/30 bg-state-pending-light p-4 text-[12px] text-text-muted" data-aos="fade-up">
          Connect the vault owner wallet to manage on-chain allowlists.
        </div>
      )}

      <div className="space-y-6">
        <div data-aos="fade-up">
          <RecipientSection isOwner={isOwner} agent={agentAddress} refetch={refetch} />
        </div>
        <div data-aos="fade-up" data-aos-delay="100">
          <TokenSection isOwner={isOwner} agent={agentAddress} />
        </div>
      </div>
    </div>
  );
}
