"use client";

import {useCallback, useEffect, useState} from "react";
import {TUSDT_ADDRESS} from "@/lib/bot";
import {bytesToHex, isAddress, type Address} from "viem";
import {mandateVaultAbi} from "@/lib/abi/mandate";
import {
  MAX_APPROVAL_THRESHOLD,
  approvalThresholdHint,
  parseApprovalThreshold,
} from "@/lib/contracts";
import {
  isSameAddress,
  truncateAddress,
  formatExpiry,
  formatTusdt,
  tryParseTusdt,
} from "@/lib/format";
import {explorerAddress, publicClient} from "@/lib/chain";
import {readServiceAllowlist, type ServiceAllowlistEntry} from "@/lib/reads";
import {useTreasuryState} from "@/lib/useChainRead";
import {useOwnerWrite} from "@/lib/useOwnerWrite";
import {useWalletMessageSigner, useActiveAddress} from "@/lib/usePrivyWallet";
import {credentialAuthorizationMessage, type CredentialAction} from "@/lib/credentialAuth";
import {useRole} from "@/lib/useRole";
import {useVault} from "@/lib/useVault";
import {Panel, PanelNote} from "@/components/dashboard/Panel";
import {DailyCapMeter} from "@/components/dashboard/DailyCapMeter";
import {Button} from "@/components/ui/Button";
import {TextInput, Field, Toggle} from "@/components/ui/Input";
import {Chip} from "@/components/ui/Chip";
import {Skeleton} from "@/components/ui/Row";
import {PageLoader} from "@/components/ui/PageLoader";

/**
 * Owner control plane: register agents, set policy, manage the token and service allowlists.
 *
 * Every action here is an owner-signed transaction from the organization wallet. There is no server
 * route for any of it, because there is no server credential that could be abused for it. The
 * backend cannot register an agent, widen a limit, or spend, by construction.
 */
export default function AgentsPage() {
  const {vault} = useVault();
  const treasury = useTreasuryState(vault);
  const {isOwner} = useRole();

  const [address, setAddress] = useState("");
  const [lookupError, setLookupError] = useState<string | undefined>();
  const [resolved, setResolved] = useState<string | undefined>();

  const lookup = async () => {
    setLookupError(undefined);
    setResolved(undefined);
    const candidate = address.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(candidate)) {
      setLookupError("Enter a 20-byte hex address.");
      return;
    }
    try {
      // The session is scoped to one vault by the layout, so look the agent up there rather than
      // in whatever treasury happened to be configured for this build.
      if (!vault) throw new Error("No vault for this wallet.");
      const registered = await publicClient.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: "agents",
        args: [candidate as `0x${string}`],
      });
      if (!registered) {
        setLookupError("That address is not registered on this vault.");
        return;
      }
      setResolved(candidate);
    } catch {
      setLookupError("Could not read the vault. Is the RPC reachable?");
    }
  };

  if (treasury.loading) return <PageLoader label="Reading vault state..." fill />;

  return (
    <div className="p-6">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold text-text-primary tracking-tight">Agents</h1>
        <p className="mt-1 text-[13px] text-text-muted">
          Registration, policy, and allowlists. All writes are owner-signed.
        </p>
      </header>

      {!isOwner ? (
        <div className="mb-4 rounded-lg border border-border bg-surface-muted px-4 py-3 text-[12px] text-text-muted">
          You are not the vault owner, so this page is read-only and the controls are hidden.
        </div>
      ) : null}

      <div className="grid gap-4">
        <Panel title="Find an agent" subtitle="Look up a registered agent by address">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[280px] flex-1">
              <Field label="Agent address" hint="Must already be registered on this vault.">
                <TextInput
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="0x..."
                  spellCheck={false}
                />
              </Field>
            </div>
            <Button onClick={lookup}>Look up</Button>
          </div>
          {lookupError ? <p className="mt-2 text-[12px] text-state-blocked">{lookupError}</p> : null}
          {resolved ? (
            <AgentEditor vault={vault!} agent={resolved as `0x${string}`} onChanged={treasury.refetch} />
          ) : null}
        </Panel>

        <Panel title="Register an agent" subtitle="Bind an address the agent may spend as">
          <RegisterAgent vault={vault!} onChanged={treasury.refetch} disabled={!isOwner} />
        </Panel>

        <Panel title="Executors" subtitle="Addresses allowed to settle approved requests">
          <ExecutorManager vault={vault!} onChanged={treasury.refetch} disabled={!isOwner} />
        </Panel>

        <Panel
          title="API credentials"
          subtitle="Issue, rotate or revoke the key an agent uses to call the API"
        >
          <CredentialManager vault={vault!} agent={resolved as `0x${string}` | undefined} disabled={!isOwner} />
        </Panel>
      </div>
    </div>
  );
}

function AgentEditor({vault, agent, onChanged}: {vault: Address; agent: `0x${string}`; onChanged: () => void}) {
  const [state, setState] = useState<{
    active: boolean;
    maxPerTx: bigint;
    dailyCap: bigint;
    spentToday: bigint;
    remaining: bigint;
    expiry: bigint;
    threshold: number;
    tokenAllowed: boolean;
  } | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const [maxPerTx, setMaxPerTx] = useState("");
  const [dailyCap, setDailyCap] = useState("");
  const [threshold, setThreshold] = useState("1");
  const [expiryDays, setExpiryDays] = useState("30");
  const [active, setActive] = useState(false);
  const [policyError, setPolicyError] = useState<string | undefined>();

  const days = Number(expiryDays);
  const thresholdValue = parseApprovalThreshold(threshold);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [policy, remaining, tokenAllowed] = await Promise.all([
        publicClient.readContract({address: vault, abi: mandateVaultAbi, functionName: "getPolicy", args: [agent]}),
        publicClient.readContract({address: vault, abi: mandateVaultAbi, functionName: "remainingDailyCap", args: [agent]}),
        publicClient.readContract({
          address: vault,
          abi: mandateVaultAbi,
          functionName: "allowedTokens",
          args: [agent, TUSDT_ADDRESS],
        }),
      ]);
      setState({
        active: Boolean(policy.active),
        maxPerTx: policy.maxPerTx,
        dailyCap: policy.dailyCap,
        spentToday: policy.spentToday,
        remaining,
        expiry: policy.expiry,
        threshold: Number(policy.approvalThreshold),
        tokenAllowed: Boolean(tokenAllowed),
      });
      setMaxPerTx((policy.maxPerTx / 10n ** 6n).toString());
      setDailyCap((policy.dailyCap / 10n ** 6n).toString());
      setThreshold(String(Number(policy.approvalThreshold)));
      setActive(Boolean(policy.active));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the policy.");
    } finally {
      setLoading(false);
    }
  }, [agent]);

  useEffect(() => {
    void load();
  }, [load]);

  const savePolicy = useOwnerWrite(() => {
    void load();
    onChanged();
  });
  const setToken = useOwnerWrite(() => {
    void load();
    onChanged();
  });

  if (loading) return <div className="mt-4"><Skeleton className="h-24 w-full" /></div>;
  if (error) return <div className="mt-4"><PanelNote tone="error">{error}</PanelNote></div>;
  if (!state) return null;

  const expiry = formatExpiry(state.expiry);

  return (
    <div className="mt-5 space-y-5 border-t border-border pt-5">
      <div className="flex flex-wrap items-center gap-3">
        <a href={explorerAddress(agent)} target="_blank" rel="noopener noreferrer" className="font-mono text-[13px] text-accent hover:underline">
          {truncateAddress(agent)}
        </a>
        <Chip tone={state.active ? "mint" : "blush"}>{state.active ? "active" : "inactive"}</Chip>
        {state.tokenAllowed ? <Chip tone="mint">tUSDT allowed</Chip> : <Chip tone="blush">tUSDT denied</Chip>}
        <Chip tone="outline">threshold {state.threshold}</Chip>
        <Chip tone={expiry.expired ? "blush" : "outline"}>{expiry.label}</Chip>
      </div>

      <DailyCapMeter spent={state.spentToday} cap={state.dailyCap} remaining={state.remaining} />

      <form
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
        onSubmit={(e) => {
          e.preventDefault();
          const maxTx = tryParseTusdt(maxPerTx);
          const cap = tryParseTusdt(dailyCap);
          const thresholdValue = parseApprovalThreshold(threshold);

          // Validate everything and say why, instead of returning silently. A form that swallows a
          // bad value looks identical to a form that is merely not submitting.
          const problem =
            maxTx === null || cap === null
              ? "Caps must be positive tUSDT amounts with up to 6 decimal places."
              : maxTx === 0n || cap === 0n
                ? "A zero cap denies every spend. Set both caps above zero to let this agent spend."
                : maxTx > cap
                  ? "Max per transaction cannot exceed the daily cap."
                  : thresholdValue === null
                    ? `Approvals needed must be a whole number from 0 to ${MAX_APPROVAL_THRESHOLD}.`
                    : !(days >= 0)
                      ? "Expiry cannot be negative."
                      : undefined;
          setPolicyError(problem);
          if (problem || maxTx === null || cap === null || thresholdValue === null) return;

          const expiryTs =
            days > 0 ? BigInt(Math.floor(Date.now() / 1000) + days * 86_400) : 0n;

          void savePolicy.run({
            address: vault,
            abi: mandateVaultAbi,
            functionName: "setAgentPolicy",
            args: [agent, maxTx, cap, expiryTs, thresholdValue, active],
          });
        }}
      >
        <Field label="Max per tx (tUSDT)">
          <TextInput value={maxPerTx} onChange={(e) => setMaxPerTx(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Daily cap (tUSDT)">
          <TextInput value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Approvals needed" hint={approvalThresholdHint(thresholdValue)}>
          <TextInput
            value={threshold}
            onChange={(e) => {
              setThreshold(e.target.value);
              setPolicyError(undefined);
            }}
            inputMode="numeric"
          />
        </Field>
        <Field label="Expiry (days, 0 = never)">
          <TextInput value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} inputMode="numeric" />
        </Field>
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-center gap-2 pb-2">
            <Toggle checked={active} onChange={setActive} label="Active" />
          </div>
          <Button type="submit" disabled={savePolicy.pending} className="mb-1">
            {savePolicy.pending ? "Saving..." : "Save policy"}
          </Button>
        </div>
      </form>

      {policyError ? <p className="text-[12px] text-state-blocked">{policyError}</p> : null}
      {savePolicy.error ? <p className="text-[12px] text-state-blocked">{savePolicy.error}</p> : null}

      {/* Auto-approve removes the only human checkpoint, so state it rather than leaving it implied. */}
      {thresholdValue === 0 ? (
        <div className="mt-3 rounded-lg border border-state-pending/40 bg-state-pending-light px-4 py-3">
          <div className="text-[13px] font-semibold text-text-primary">
            This agent settles without human approval.
          </div>
          <p className="mt-1 text-[12px] text-text-secondary">
            Requests are approved on arrival and the executor can spend immediately. The per-tx cap,
            daily cap, token allowlist and recipient allowlist are then the only controls on where the
            money goes. Raise this to at least 1 to require an owner signature first.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <span className="text-[12px] text-text-muted">Settlement token allowlist</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={setToken.pending}
          onClick={() =>
            setToken.run({
              address: vault,
              abi: mandateVaultAbi,
              functionName: "setAllowedToken",
              args: [agent, TUSDT_ADDRESS, !state.tokenAllowed],
            })
          }
        >
          {setToken.pending ? "Saving..." : state.tokenAllowed ? "Revoke tUSDT" : "Allow tUSDT"}
        </Button>
        {setToken.error ? <span className="text-[12px] text-state-blocked">{setToken.error}</span> : null}
      </div>

      <RecipientAllowlist vault={vault} agent={agent} onChanged={onChanged} />
    </div>
  );
}

/**
 * Recipients this agent may pay.
 *
 * Without an entry here every request from the agent reverts `NotAuthorized`, so this is the step
 * that actually unlocks spending. A recipient entry can also be tighter than the agent's own policy,
 * which is the reason to use it instead of relying on the global cap alone.
 *
 * Caps are optional: `maxPerTx == 0` means this recipient is bounded only by the agent's policy, and
 * `dailyCap == 0` means the recipient has no daily ceiling of its own.
 */
function RecipientAllowlist({
  vault,
  agent,
  onChanged,
}: {
  vault: Address;
  agent: `0x${string}`;
  onChanged: () => void;
}) {
  const [entries, setEntries] = useState<ServiceAllowlistEntry[] | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [maxPerTx, setMaxPerTx] = useState("");
  const [dailyCap, setDailyCap] = useState("");
  const [expiryDays, setExpiryDays] = useState("0");

  const load = useCallback(async () => {
    try {
      setEntries(await readServiceAllowlist({vault, agent}));
      setLoadError(undefined);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not read the recipient allowlist.");
    }
  }, [vault, agent]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useOwnerWrite(() => {
    void load();
    onChanged();
  });
  const remove = useOwnerWrite(() => {
    void load();
    onChanged();
  });

  const trimmed = target.trim();
  const maxTxBase = maxPerTx.trim() === "" ? 0n : tryParseTusdt(maxPerTx);
  const capBase = dailyCap.trim() === "" ? 0n : tryParseTusdt(dailyCap);
  const days = Number(expiryDays) || 0;

  const error = !isAddress(trimmed)
    ? "Enter the address the agent may pay."
    : maxTxBase === null
      ? "Max per transaction must be a valid tUSDT amount."
      : capBase === null
        ? "Daily cap must be a valid tUSDT amount."
        : maxTxBase > 0n && capBase > 0n && maxTxBase > capBase
          ? "Max per transaction cannot exceed the daily cap."
          : days < 0 || !Number.isFinite(days)
            ? "Expiry cannot be negative."
            : undefined;

  const expiryTs = days > 0 ? BigInt(Math.floor(Date.now() / 1000) + days * 86_400) : 0n;

  return (
    <div className="mt-5 space-y-4 border-t border-border pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-text-primary">Recipients this agent may pay</h3>
        <span className="text-[11px] text-text-muted">
          A request to an address that is not listed here reverts on-chain.
        </span>
      </div>

      {entries && entries.length > 0 ? (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li
              key={entry.target}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12px] text-text-primary">
                    {truncateAddress(entry.target)}
                  </span>
                  <Chip tone={entry.allowed ? "mint" : "blush"}>{entry.allowed ? "allowed" : "removed"}</Chip>
                </div>
                <div className="mt-0.5 text-[11px] text-text-muted">
                  {entry.label || "no label"}
                  {" · "}
                  {entry.maxPerTx > 0n
                    ? `max ${formatTusdt(entry.maxPerTx)} tUSDT`
                    : "no per-tx cap of its own"}
                  {entry.dailyCap > 0n ? ` · daily ${formatTusdt(entry.dailyCap)}` : ""}
                  {entry.expiry > 0n
                    ? ` · ${formatExpiry(entry.expiry).label}`
                    : " · never expires"}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={remove.pending}
                onClick={() =>
                  remove.run({
                    address: vault,
                    abi: mandateVaultAbi,
                    functionName: "setAllowedService",
                    args: [agent, entry.target, "", 0n, 0n, 0n, !entry.allowed],
                  })
                }
              >
                {entry.allowed ? "Remove" : "Re-allow"}
              </Button>
            </li>
          ))}
        </ul>
      ) : loadError ? (
        <PanelNote tone="error">{loadError}</PanelNote>
      ) : (
        <PanelNote>
          No recipients listed. Until at least one is allowed, this agent can authenticate but every
          spend it requests will be rejected by the vault.
        </PanelNote>
      )}

      <form
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (error) return;
          void save.run({
            address: vault,
            abi: mandateVaultAbi,
            functionName: "setAllowedService",
            args: [agent, trimmed as Address, label.trim(), maxTxBase ?? 0n, capBase ?? 0n, expiryTs, true],
          });
        }}
      >
        <Field label="Recipient">
          <TextInput
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="0x..."
            spellCheck={false}
            className="font-mono"
          />
        </Field>
        <Field label="Label" hint="Shown in this list only.">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="model-api" />
        </Field>
        <Field label="Max per tx (tUSDT)" hint="0 = agent policy only">
          <TextInput value={maxPerTx} onChange={(e) => setMaxPerTx(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Daily cap (tUSDT)" hint="0 = none">
          <TextInput value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Expiry (days, 0 = never)">
          <TextInput value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} inputMode="numeric" />
        </Field>

        <div className="flex items-center gap-3 xl:col-span-5">
          <Button type="submit" disabled={!!error || save.pending}>
            {save.pending ? "Confirming..." : "Allow recipient"}
          </Button>
          {error ? <span className="text-[12px] text-state-blocked">{error}</span> : null}
          {save.error ? <span className="text-[12px] text-state-blocked">{save.error}</span> : null}
          {remove.error ? <span className="text-[12px] text-state-blocked">{remove.error}</span> : null}
        </div>
      </form>
    </div>
  );
}

function RegisterAgent({vault, onChanged, disabled}: {vault: Address; onChanged: () => void; disabled: boolean}) {
  const [agent, setAgent] = useState("");
  const write = useOwnerWrite(onChanged);
  const [error, setError] = useState<string | undefined>();

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const candidate = agent.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(candidate)) {
          setError("Enter a 20-byte hex address.");
          return;
        }
        setError(undefined);
        void write.run({
          address: vault,
          abi: mandateVaultAbi,
          functionName: "setAgent",
          args: [candidate as `0x${string}`, true],
        });
      }}
    >
      <div className="min-w-[280px] flex-1">
        <Field label="Agent address" hint="A registered agent can request spends but holds no funds itself.">
          <TextInput value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="0x..." spellCheck={false} />
        </Field>
      </div>
      <Button type="submit" disabled={disabled || write.pending}>
        {write.pending ? "Registering..." : "Register agent"}
      </Button>
      {error ? <p className="w-full text-[12px] text-state-blocked">{error}</p> : null}
      {write.error ? <p className="w-full text-[12px] text-state-blocked">{write.error}</p> : null}
      {write.okKey ? <p className="w-full text-[12px] text-state-approved">Registered on-chain.</p> : null}
    </form>
  );
}

function ExecutorManager({vault, onChanged, disabled}: {vault: Address; onChanged: () => void; disabled: boolean}) {
  const [address, setAddress] = useState("");
  const write = useOwnerWrite(onChanged);
  const [error, setError] = useState<string | undefined>();

  return (
    <div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const candidate = address.trim();
          if (!/^0x[0-9a-fA-F]{40}$/.test(candidate)) {
            setError("Enter a 20-byte hex address.");
            return;
          }
          setError(undefined);
          void write.run({
            address: vault,
            abi: mandateVaultAbi,
            functionName: "setExecutor",
            args: [candidate as `0x${string}`, true],
          });
        }}
      >
        <div className="min-w-[280px] flex-1">
          <Field
            label="Executor address"
            hint="Gas-only. An executor can settle an approved request but cannot approve, change policy, or withdraw."
          >
            <TextInput value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x..." spellCheck={false} />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={disabled || write.pending}>
          {write.pending ? "Adding..." : "Add executor"}
        </Button>
      </form>
      {error ? <p className="mt-2 text-[12px] text-state-blocked">{error}</p> : null}
      {write.error ? <p className="mt-2 text-[12px] text-state-blocked">{write.error}</p> : null}
    </div>
  );
}
/**
 * Credential lifecycle for one registered agent.
 *
 * The owner signs a short-lived authorization, the API verifies it against the vault owner read
 * from the chain, and only then does a key exist. The plaintext is rendered once and never
 * re-fetchable, which is the same property the SpendArc dashboard lacked entirely.
 */
function CredentialManager({vault, agent, disabled}: {vault: Address; agent?: `0x${string}`; disabled: boolean}) {
  const {signMessage} = useWalletMessageSigner();
  const {address: connected} = useActiveAddress();
  const [agentId, setAgentId] = useState("");
  // createVault registers the caller as the vault's first agent, so the connected wallet is already a
  // valid agent here and is what the operator almost always wants. Default to it rather than making
  // them retype the address the app already knows.
  const [agentAddress, setAgentAddress] = useState(agent ?? "");
  const [busy, setBusy] = useState<CredentialAction | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [issued, setIssued] = useState<{apiKey: string; keyHint: string} | null>(null);

  // Seed from the lookup when it resolves, but never clobber a different address in this field.
  useEffect(() => {
    if (agent) setAgentAddress(agent);
  }, [agent]);

  // With no explicit choice, the connected owner is the agent.
  const effectiveAddress = agentAddress.trim() || (connected ?? "");
  const usingConnectedDefault = !agentAddress.trim() && !!connected;

  const run = async (action: CredentialAction) => {
    setError(undefined);
    setIssued(null);

    const id = agentId.trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
      setError("agentId must be 2-64 characters of a-z, 0-9, underscore or dash.");
      return;
    }
    const target = effectiveAddress.trim();
    if (!isAddress(target)) {
      setError("Connect a wallet, or enter the agent address this key belongs to.");
      return;
    }

    setBusy(action);
    try {
      const authorization = {
        action,
        agentId: id,
        agentAddress: target as Address,
        // Signed explicitly so the server can confirm the signer really owns this treasury. See
        // verifyCredentialAuthorization: it refuses a signature naming someone else's vault.
        vault,
        issuedAt: Math.floor(Date.now() / 1000),
        // Nonce makes two signatures for the same second distinguishable; it is bound into the
        // signed bytes, so a replayed request still needs its own fresh signature.
        nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))).slice(2),
      };
      const signature = await signMessage(credentialAuthorizationMessage(authorization));

      const res = await fetch("/api/agents/credentials", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({action, authorization, signature}),
      });
      const payload = (await res.json()) as {error?: string; apiKey?: string; keyHint?: string};
      if (!res.ok) {
        setError(payload.error ?? `Request failed with ${res.status}`);
        return;
      }
      if (payload.apiKey) setIssued({apiKey: payload.apiKey, keyHint: payload.keyHint ?? ""});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete the request.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Agent id"
          hint="A stable label for this agent's credential. Lowercase letters, digits, dash, underscore."
        >
          <TextInput
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="research-agent"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Agent address"
          hint="Defaults to your connected wallet, which createVault registered as an agent. Change it only to issue a key for a different registered agent."
        >
          <TextInput
            value={effectiveAddress}
            onChange={(e) => setAgentAddress(e.target.value)}
            placeholder={connected ?? "0x..."}
            spellCheck={false}
            className="font-mono"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Button onClick={() => void run("issue")} disabled={disabled || busy !== null}>
          {busy === "issue" ? "Waiting for signature..." : "Issue key"}
        </Button>
        <Button variant="secondary" onClick={() => void run("rotate")} disabled={disabled || busy !== null}>
          {busy === "rotate" ? "Rotate..." : "Rotate"}
        </Button>
        <Button variant="secondary" onClick={() => void run("revoke")} disabled={disabled || busy !== null}>
          {busy === "revoke" ? "Revoking..." : "Revoke"}
        </Button>
      </div>

      {isAddress(effectiveAddress.trim()) ? (
        <PanelNote>
          Authorizing <span className="tabular-nums">{truncateAddress(effectiveAddress.trim())}</span>
          {usingConnectedDefault ? " (your connected wallet)" : ""}. Rotate revokes every existing key
          for this agent id before issuing a new one. Revoke leaves the on-chain policy untouched: the
          key can no longer call the API, but the address keeps whatever allowance it already had until
          the owner tightens it.
        </PanelNote>
      ) : (
        <PanelNote>
          Connect a wallet to issue a key for yourself, or enter the address of an agent already
          registered on this vault.
        </PanelNote>
      )}

      {error ? <p className="text-[12px] text-state-blocked">{error}</p> : null}

      {issued ? (
        <div className="rounded-lg border border-state-approved/30 bg-state-approved-light px-4 py-3">
          <div className="text-[12px] font-medium text-state-approved">
            Key issued ({issued.keyHint}). Shown once.
          </div>
          <code className="mt-2 block break-all rounded bg-surface px-3 py-2 text-[11px] text-text-primary">
            {issued.apiKey}
          </code>
          <p className="mt-2 text-[11px] text-text-muted">
            Copy it into the agent&rsquo;s secret store now. Mandate keeps only a SHA-256 hash, so it
            cannot be shown again - a lost key is replaced by rotating, never recovered.
          </p>
        </div>
      ) : null}
    </div>
  );
}
