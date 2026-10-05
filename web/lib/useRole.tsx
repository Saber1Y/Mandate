"use client";

import {createContext, useContext, useEffect, useState} from "react";
import {useActiveAddress} from "./usePrivyWallet";
import {isSameAddress, type Address} from "./format";
import {MissingMandateConfigError} from "./bot";
import {publicClient} from "./chain";
import {mandateVaultAbi} from "./abi/mandate";
import {useVault} from "./useVault";

export interface RoleValue {
  isOwner: boolean;
  isApprover: boolean;
  isConnected: boolean;
  address?: Address;
  /** The treasury this session is scoped to, resolved from the connected address. */
  vault?: Address;
  vaultOwner?: Address;
  loading: boolean;
  error?: string;
}

const RoleContext = createContext<RoleValue>({isOwner: false, isApprover: false, isConnected: false, loading: true});

/**
 * Owner and approver status, resolved once at the layout and shared with every page.
 *
 * Both answers come from the vault itself rather than a server response. That matters: a role shown
 * by this UI is only ever advisory, but it must at minimum agree with what the contract enforces,
 * or the operator gets confused about why a transaction reverts.
 *
 * Authority is always evaluated against the CONNECTED ADDRESS's own vault. A session is scoped to
 * one treasury, so there is no vault in which an address could appear to be an owner of somebody
 * else's funds.
 */
export function RoleProvider({children}: {children: React.ReactNode}) {
  const {address, isConnected} = useActiveAddress();
  const {vault} = useVault();
  const [vaultOwner, setVaultOwner] = useState<Address | undefined>();
  const [approver, setApprover] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      setLoading(true);
      setError(undefined);

      // No vault yet means no role exists to report. That is an onboarding state, not a failure.
      if (!vault) {
        setVaultOwner(undefined);
        setApprover(false);
        setLoading(false);
        return;
      }

      try {
        const owner = await publicClient.readContract({
          address: vault,
          abi: mandateVaultAbi,
          functionName: "owner",
        });

        // Approver status is only meaningful for a registered, connected address.
        let isApprover = false;
        if (address) {
          try {
            isApprover = await publicClient.readContract({
              address: vault,
              abi: mandateVaultAbi,
              functionName: "approvers",
              args: [address],
            });
          } catch {
            isApprover = false;
          }
        }

        if (cancelled) return;
        setVaultOwner(owner as Address);
        setApprover(Boolean(isApprover));
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof MissingMandateConfigError
            ? e.message
            : "Could not read the vault owner from BOT Chain.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [address, vault]);

  const value: RoleValue = {
    // Only an address that owns a vault can be its owner, so gate on `vault` being present rather
    // than on the owner read having happened.
    isOwner: isConnected && !!vault && !!vaultOwner && isSameAddress(address, vaultOwner),
    isApprover: isConnected && (!!vaultOwner && isSameAddress(address, vaultOwner) || approver),
    isConnected,
    address,
    vault,
    vaultOwner,
    loading,
    error,
  };

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  return useContext(RoleContext);
}