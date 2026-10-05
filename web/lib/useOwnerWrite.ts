"use client";

import {useState} from "react";
import type {Abi} from "viem";
import {botChain} from "./bot";
import {usePrivyWalletClient} from "./usePrivyWallet";
import {waitForReceiptRaw} from "./txwait";

export type WriteArgs = {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
};

export type WriteStatus = {pending: boolean; error?: string; okKey?: number};

/**
 * Owner write with the backend confirmation pattern: submit → wait for raw receipt → READ BACK
 * (caller's refetch) to confirm the effect. Never uses a formatted waitForTransactionReceipt.
 *
 * `run` resolves to whether the transaction actually succeeded, because callers must not present
 * success for a write that reverted or never landed.
 */
export function useOwnerWrite(refetch: () => void) {
  const {getClient} = usePrivyWalletClient();
  const [status, setStatus] = useState<WriteStatus>({pending: false});

  const run = async (args: WriteArgs) => {
    setStatus({pending: true});
    try {
      const client = await getClient();
      if (!client) throw new Error("No wallet connected");
      const hash = await client.writeContract({
        ...args,
        chain: botChain,
        account: client.account!,
      });
      const result = await waitForReceiptRaw(hash);
      if (result === "reverted") {
        setStatus({pending: false, error: "Transaction reverted on-chain"});
        return false;
      }
      refetch(); // read-back the resulting state
      setStatus({pending: false, okKey: Date.now()});
      return true;
    } catch (e) {
      const err = e as {shortMessage?: string; message?: string};
      setStatus({pending: false, error: err.shortMessage ?? err.message ?? "Transaction failed"});
      return false;
    }
  };

  return {run, ...status};
}
