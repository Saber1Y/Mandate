import type {Address} from "viem";
import {botChain, mandateContracts} from "./bot";

/**
 * Credential authorization payload - the contract between the wallet and the API.
 *
 * Kept in its own module because the browser needs to build the exact bytes it signs while the
 * server needs to rebuild them for verification. Both sides must import the same function here;
 * deriving the message twice is how signature verification silently rots.
 *
 * The payload binds the action, the agent, the chain, and the vault, and carries an expiry. A
 * captured signature is therefore useless against another agent, another vault, another chain, and
 * useless after a few minutes.
 */

export type CredentialAction = "issue" | "rotate" | "revoke";

export interface CredentialAuthorization {
  action: CredentialAction;
  agentId: string;
  agentAddress: Address;
  issuedAt: number;
  nonce: string;
}

/**
 * Canonical payload. Field order and separators are fixed because the client signs these exact
 * bytes and the server re-derives them; any change here invalidates outstanding signatures.
 */
export function credentialAuthorizationMessage(
  auth: CredentialAuthorization,
): string {
  const {vault} = mandateContracts();
  return [
    "Mandate credential authorization",
    `action: ${auth.action}`,
    `agentId: ${auth.agentId}`,
    `agent: ${auth.agentAddress}`,
    `chain: ${botChain.id}`,
    `vault: ${vault.toLowerCase()}`,
    `issuedAt: ${auth.issuedAt}`,
    `nonce: ${auth.nonce}`,
  ].join("\n");
}
