"use client";

import {usePrivy} from "@privy-io/react-auth";

/** Full-screen gate shown until the user authenticates through Privy. */
export function LoginGate() {
  const {ready, login} = usePrivy();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-muted px-6">
      <div className="w-full max-w-sm text-center">
        <div className="mb-2 text-[22px] font-semibold tracking-tight text-text-primary">Mandate</div>
        <div className="mb-8 text-[13px] text-text-muted">Agent spending control plane</div>

        <button
          onClick={() => login()}
          disabled={!ready}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-5 py-3 text-[14px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
        >
          {ready ? "Connect wallet or sign in" : "Loading..."}
        </button>

        <div className="mt-4 text-[11px] text-text-muted">
          Sign in with a wallet or email to view and control your vault.
        </div>
      </div>
    </div>
  );
}
