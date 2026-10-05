"use client";

import {useCallback, useEffect, useState} from "react";
import {TUSDT_ADDRESS, mandateContracts} from "@/lib/bot";
import {bytesToHex} from "viem";
import {mandateVaultAbi} from "@/lib/abi/mandate";
import {parseTusdt} from "@/lib/contracts";
import {isSameAddress, truncateAddress, formatExpiry} from "@/lib/format";
import {explorerAddress, publicClient} from "@/lib/chain";
import {useTreasuryState} from "@/lib/useChainRead";
import {useOwnerWrite} from "@/lib/useOwnerWrite";
import {useWalletMessageSigner} from "@/lib/usePrivyWallet";
import {credentialAuthorizationMessage, type CredentialAction} from "@/lib/credentialAuth";
import {useRole} from "@/lib/useRole";
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
  const treasury = useTreasuryState();
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
      const {vault} = mandateContracts();
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
          {resolved ? <AgentEditor agent={resolved as `0x${string}`} onChanged={treasury.refetch} /> : null}
        </Panel>

        <Panel title="Register an agent" subtitle="Bind an address the agent may spend as">
          <RegisterAgent onChanged={treasury.refetch} disabled={!isOwner} />
        </Panel>

        <Panel title="Executors" subtitle="Addresses allowed to settle approved requests">
          <ExecutorManager onChanged={treasury.refetch} disabled={!isOwner} />
        </Panel>

        <Panel
          title="API credentials"
          subtitle="Issue, rotate or revoke the key an agent uses to call the API"
        >
          <CredentialManager agent={resolved as `0x${string}` | undefined} disabled={!isOwner} />
        </Panel>
      </div>
    </div>
  );
}

function AgentEditor({agent, onChanged}: {agent: `0x${string}`; onChanged: () => void}) {
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const {vault} = mandateContracts();
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
          let maxTx: bigint;
          let cap: bigint;
          try {
            maxTx = parseTusdt(maxPerTx);
            cap = parseTusdt(dailyCap);
          } catch {
            return;
          }
          if (maxTx === 0n || cap === 0n) return;

          const days = Number(expiryDays);
          const expiryTs =
            days > 0
              ? BigInt(Math.floor(Date.now() / 1000) + days * 86_400)
              : 0n;

          void savePolicy.run({
            address: mandateContracts().vault,
            abi: mandateVaultAbi,
            functionName: "setAgentPolicy",
            args: [
              agent,
              maxTx,
              cap,
              expiryTs,
              Number(threshold) || 1,
              active,
            ],
          });
        }}
      >
        <Field label="Max per tx (tUSDT)">
          <TextInput value={maxPerTx} onChange={(e) => setMaxPerTx(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Daily cap (tUSDT)">
          <TextInput value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Approvals needed">
          <TextInput value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="numeric" />
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
      {savePolicy.error ? <p className="text-[12px] text-state-blocked">{savePolicy.error}</p> : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <span className="text-[12px] text-text-muted">Settlement token allowlist</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={setToken.pending}
          onClick={() =>
            setToken.run({
              address: mandateContracts().vault,
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
    </div>
  );
}

function RegisterAgent({onChanged, disabled}: {onChanged: () => void; disabled: boolean}) {
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
          address: mandateContracts().vault,
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

function ExecutorManager({onChanged, disabled}: {onChanged: () => void; disabled: boolean}) {
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
            address: mandateContracts().vault,
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
function CredentialManager({agent, disabled}: {agent?: `0x${string}`; disabled: boolean}) {
  const {signMessage} = useWalletMessageSigner();
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState<CredentialAction | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [issued, setIssued] = useState<{apiKey: string; keyHint: string} | null>(null);

  const run = async (action: CredentialAction) => {
    setError(undefined);
    setIssued(null);

    const id = agentId.trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
      setError("agentId must be 2-64 characters of a-z, 0-9, underscore or dash.");
      return;
    }
    if (!agent) {
      setError("Look up the agent address above first. The signature must bind to a registered agent.");
      return;
    }

    setBusy(action);
    try {
      const authorization = {
        action,
        agentId: id,
        agentAddress: agent,
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
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
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
        </div>
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

      {agent ? (
        <PanelNote>
          Authorizing <span className="tabular-nums">{truncateAddress(agent)}</span>. Rotate revokes
          every existing key for this agent id before issuing a new one. Revoke leaves the on-chain
          policy untouched: the key can no longer call the API, but the address keeps whatever
          allowance it already had until the owner tightens it.
        </PanelNote>
      ) : (
        <PanelNote>Look up an agent above to manage its credentials.</PanelNote>
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
