"use client";

import {useCallback} from "react";
import {usePrivy, useWallets} from "@privy-io/react-auth";
import {createWalletClient, custom, type Address, type WalletClient} from "viem";
import {botChain} from "./bot";
import {publicClient} from "./chain";

/**
 * Active wallet address from Privy - the single source of truth for wallet state.
 * Only reports a connected wallet once the Privy session is both resolved and authenticated,
 * so a restored-but-unauthenticated session can never masquerade as a connection.
 */
export function useActiveAddress() {
  const {ready, authenticated} = usePrivy();
  const {wallets} = useWallets();
  const wallet = wallets[0];
  const connected = ready && authenticated && !!wallet;
  return {
    address: connected ? (wallet.address as Address) : undefined,
    isConnected: connected,
  };
}

/** Build a viem wallet client from the connected Privy wallet for owner writes. */
export function usePrivyWalletClient() {
  const {ready, authenticated} = usePrivy();
  const {wallets} = useWallets();
  const wallet = wallets[0];
  const connected = ready && authenticated && !!wallet;

  const getClient = useCallback(async (): Promise<WalletClient | null> => {
    if (!connected || !wallet) return null;
    if (String(wallet.chainId) !== String(botChain.id)) {
      await wallet.switchChain(botChain.id);
    }
    const provider = await wallet.getEthereumProvider();
    return createWalletClient({
      account: wallet.address as Address,
      chain: botChain,
      transport: custom(provider),
    });
  }, [connected, wallet]);

  return {getClient, address: wallet?.address as Address | undefined, hasWallet: connected};
}

/**
 * EIP-191 message signing from the connected Privy wallet.
 *
 * Used for credential issuance, where the server must verify that the organization owner approved a
 * specific agent before it will mint an API key. Separate from `useOwnerWrite` on purpose: a signed
 * message authorizes, it does not move funds and must never be described as a transaction.
 */
export function useWalletMessageSigner() {
  const {getClient} = usePrivyWalletClient();
  const signMessage = useCallback(
    async (message: string): Promise<`0x${string}`> => {
      const client = await getClient();
      if (!client) throw new Error("No wallet connected");
      if (!client.account) throw new Error("Wallet has no account to sign with");
      return client.signMessage({message, account: client.account});
    },
    [getClient],
  );
  return {signMessage};
}

/** Wait for an on-chain receipt via the BOT Chain public client. */
export async function waitForReceipt(hash: `0x${string}`) {
  return publicClient.waitForTransactionReceipt({hash});
}
