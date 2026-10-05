"use client";

import {useCallback, useEffect, useState} from "react";
import type {Address} from "viem";
import {mandateContracts, MissingMandateConfigError} from "./bot";
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

/** Treasury-level reads: vault owner, settlement balance, paused flag. */
export function useTreasuryState(): AsyncState<TreasuryState> {
  const read = useCallback(() => readTreasuryState(), []);
  return useAsyncRead(read, []);
}

/**
 * One agent's live policy and remaining budget.
 *
 * With no connected address this reports an idle state rather than an error: "not connected" is a
 * normal condition for a page that calls this hook unconditionally, and surfacing it as a failure
 * would make the panel claim something is broken when nothing is.
 */
export function useAgentBudget(agent?: Address): AsyncState<AgentBudgetState> {
  const read = useCallback(async () => {
    if (!agent) throw new Error("No agent connected.");
    return readAgentBudget(agent);
  }, [agent]);
  const state = useAsyncRead(read, [agent]);
  if (!agent) return {loading: false, refetch: state.refetch};
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
  agent?: Address;
  fromBlock?: bigint;
  toBlock?: bigint;
  limit?: number;
} = {}): AsyncState<SpendEvent[]> {
  const {agent, fromBlock, toBlock, limit} = params;
  const read = useCallback(
    () => readSpendHistory({agent, fromBlock, toBlock, limit}),
    [agent, fromBlock, toBlock, limit],
  );
  return useAsyncRead(read, [agent, fromBlock, toBlock, limit]);
}

/** True when the app has enough configuration to talk to a vault at all. */
export function useMandateConfigured(): {configured: boolean; vault?: Address; error?: string} {
  const [result, setResult] = useState<{configured: boolean; vault?: Address; error?: string}>({
    configured: false,
  });

  useEffect(() => {
    try {
      const {vault} = mandateContracts();
      setResult({configured: true, vault});
    } catch (e) {
      setResult({
        configured: false,
        error: e instanceof Error ? e.message : "Mandate is not configured.",
      });
    }
  }, []);

  return result;
}