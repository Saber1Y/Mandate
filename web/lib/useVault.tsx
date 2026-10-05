"use client";

import {createContext, useCallback, useContext, useEffect, useMemo, useState} from "react";
import type {Address} from "viem";
import {ZERO_ADDRESS, mandateFactory, MissingMandateConfigError} from "./bot";
import {publicClient} from "./chain";
import {mandateVaultFactoryAbi} from "./abi/mandate";
import {useActiveAddress} from "./usePrivyWallet";

/**
 * Which vault does the connected address own?
 *
 * This is the root of the multi-tenant model. Mandate used to read a single hardcoded vault from
 * the environment, which was only correct while exactly one org existed. The moment a second org
 * onboarded, that constant would point every browser at the same treasury regardless of who was
 * logged in - so the only correct source is the chain: `vaultOf(connectedAddress)`.
 *
 * Three outcomes, and callers must handle all three:
 *   - `vault` set:            this address owns a treasury
 *   - `vault` undefined + `checked`: this address has none yet, show onboarding
 *   - `error` set:            the factory could not be read, so we genuinely do not know
 */

export interface VaultState {
  /** The connected address's vault, or undefined when it has not created one. */
  vault?: Address;
  /** True once the factory has answered, whether or not a vault exists. */
  checked: boolean;
  loading: boolean;
  error?: string;
  /** Factory that answered, so pages can show it without reading env again. */
  factory?: Address;
  /** Force a re-read, e.g. right after createVault confirms. */
  refetch: () => void;
}

const VaultContext = createContext<VaultState>({
  checked: false,
  loading: true,
  refetch: () => {},
});

export function VaultProvider({children}: {children: React.ReactNode}) {
  const {address} = useActiveAddress();
  const [state, setState] = useState<{vault?: Address; checked: boolean; error?: string; factory?: Address}>({
    checked: false,
  });
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      setLoading(true);
      try {
        const factory = mandateFactory();

        // No wallet: not an error, just nothing to resolve yet.
        if (!address) {
          if (!cancelled) {
            setState({checked: false, factory});
            setLoading(false);
          }
          return;
        }

        const vault = (await publicClient.readContract({
          address: factory,
          abi: mandateVaultFactoryAbi,
          functionName: "vaultOf",
          args: [address],
        })) as Address;

        if (cancelled) return;
        setState({
          // The factory reports "no vault" as the zero address, not as a revert.
          vault: vault.toLowerCase() === ZERO_ADDRESS.toLowerCase() ? undefined : vault,
          checked: true,
          factory,
        });
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setState({
          checked: false,
          error:
            e instanceof MissingMandateConfigError
              ? e.message
              : `Could not read the Mandate factory: ${e instanceof Error ? e.message : String(e)}`,
        });
        setLoading(false);
      }
    }

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [address, nonce]);

  const value = useMemo<VaultState>(
    () => ({...state, loading, refetch}),
    [state, loading, refetch],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultState {
  return useContext(VaultContext);
}