"use client";

import {useCallback, useEffect, useState} from "react";
import type {Address} from "viem";
import {mandateFactory, MissingMandateConfigError} from "./bot";
import type {RejectedAttempt} from "./attempts";
import {
  readAgentBudget,
  readSpendHistory,
  readTreasuryState,
  type AgentBudgetState,
  type SpendEvent,
  type TreasuryState,
} from "./reads";

/**
 * Client hooks for chain reads.
 *
 * Every read goes straight to BOT Chain. There is deliberately no local copy of balances, policies,
 * or request state: a cached mirror is exactly how the old SpendArc app came to advertise limits
 * the vault would refuse. If the RPC is slow the UI shows a loading state, never a stale number
 * presented as current.
 */

export interface AsyncState<T> {
  data?: T;
  loading: boolean;
  error?: string;
  /** Exposed so owner actions can force a read-back after a write confirms. */
  refetch: () => void;
}

function useAsyncRead<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    fn()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message =
          e instanceof MissingMandateConfigError
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e);
        setError(message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return {data, loading, error, refetch};
}

/**
 * Treasury-level reads: vault owner, settlement balance, paused flag.
 *
 * Takes the vault explicitly. With no vault the state is idle, which is what an address that has
 * not onboarded should see - not an error page claiming the chain is broken.
 */
export function useTreasuryState(vault?: Address): AsyncState<TreasuryState> {
  const read = useCallback(async () => {
    if (!vault) throw new Error("No vault.");
    return readTreasuryState(vault);
  }, [vault]);
  const state = useAsyncRead(read, [vault]);
  if (!vault) return {loading: false, refetch: state.refetch};
  return state;
}

/**
 * One agent's live policy and remaining budget.
 *
 * With no connected address this reports an idle state rather than an error: "not connected" is a
 * normal condition for a page that calls this hook unconditionally, and surfacing it as a failure
 * would make the panel claim something is broken when nothing is.
 */
export function useAgentBudget(vault?: Address, agent?: Address): AsyncState<AgentBudgetState> {
  const read = useCallback(async () => {
    if (!vault || !agent) throw new Error("No agent connected.");
    return readAgentBudget(vault, agent);
  }, [vault, agent]);
  const state = useAsyncRead(read, [vault, agent]);
  if (!vault || !agent) return {loading: false, refetch: state.refetch};
  return state;
}

/**
 * Recent spend activity from contract events.
 *
 * `fromBlock` defaults to deployment so a fresh vault shows a complete history. Long-running
 * deployments should pass an explicit recent window, since an unbounded getLogs range over a
 * public RPC is the usual cause of a slow first paint.
 */
export function useSpendHistory(params: {
  vault?: Address;
  agent?: Address;
  fromBlock?: bigint;
  toBlock?: bigint;
  limit?: number;
} = {}): AsyncState<SpendEvent[]> {
  const {vault, agent, fromBlock, toBlock, limit} = params;
  const read = useCallback(
    () => readSpendHistory({vault: vault as Address, agent, fromBlock, toBlock, limit}),
    [vault, agent, fromBlock, toBlock, limit],
  );
  const state = useAsyncRead(read, [vault, agent, fromBlock, toBlock, limit]);
  if (!vault) return {loading: false, refetch: state.refetch};
  return state;
}

/**
 * Recent policy rejections, from the server-side attempt log rather than the chain.
 *
 * Deliberately not a chain read: a refused request reverts, so it emits nothing and there is nothing
 * to query. See lib/attempts for why that log is not a second ledger.
 */
export function useRejectedAttempts(limit = 25): AsyncState<RejectedAttempt[]> {
  return useAsyncRead(
    async () => {
      const res = await fetch(`/api/agents/attempts?limit=${limit}`);
      if (!res.ok) throw new Error(`Could not load rejections (HTTP ${res.status}).`);
      const body = (await res.json()) as {attempts?: RejectedAttempt[]};
      return body.attempts ?? [];
    },
    [limit],
  );
}

/**
 * True when the app knows which factory to talk to.
 *
 * The vault is no longer part of this: it is resolved per connected address from the factory, so
 * "configured" now means only that onboarding is possible at all.
 */
export function useMandateConfigured(): {configured: boolean; factory?: Address; error?: string} {
  const [result, setResult] = useState<{configured: boolean; factory?: Address; error?: string}>({
    configured: false,
  });

  useEffect(() => {
    try {
      setResult({configured: true, factory: mandateFactory()});
    } catch (e) {
      setResult({
        configured: false,
        error: e instanceof Error ? e.message : "Mandate is not configured.",
      });
    }
  }, []);

  return result;
}