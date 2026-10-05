import {createHash} from "node:crypto";
import {recoverMessageAddress} from "viem";
import type {Address} from "viem";
import {ZERO_ADDRESS, mandateFactory} from "./bot";
import {publicClient} from "./chain";
import {mandateVaultAbi, mandateVaultFactoryAbi} from "./abi/mandate";
import {credentialAuthorizationMessage, type CredentialAction, type CredentialAuthorization} from "./credentialAuth";

/**
 * Server-side verification of a vault-owner signature over a credential authorization.
 *
 * Issuing an agent key is the one server-side action that cannot be a contract call, because the
 * server holds the hashed key while the organization wallet holds the authority. The bridge is an
 * owner signature, verified against the OWNER READ FROM THE CHAIN on every request. There is no
 * allowlist of operator addresses in this repo: adding one would be a second source of truth that
 * could disagree with the vault.
 */

const MAX_SIGNATURE_AGE_SECONDS = 300;

export class OwnerAuthorizationError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "OwnerAuthorizationError";
    this.status = status;
  }
}

function isAgentId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(value);
}

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Verify an owner-signed credential authorization.
 *
* Checks, in order: shape of every field, signature freshness, recovery of the signer, that the
 * factory says this signer owns the vault named in the payload, that the vault agrees about its own
 * owner, and that the target is a registered agent on that vault. The last check matters because a
 * valid owner signature over an unregistered address would otherwise mint a key for an address that
 * cannot spend anything.
 */
export async function verifyCredentialAuthorization(params: {
  authorization: unknown;
  signature: unknown;
  action: CredentialAction;
}): Promise<{agentId: string; agentAddress: Address; vault: Address; nonceHash: string}> {
  const auth = params.authorization as Partial<CredentialAuthorization> | null;
  if (!auth || typeof auth !== "object") {
    throw new OwnerAuthorizationError("Missing authorization payload.");
  }
  if (auth.action !== params.action) {
    throw new OwnerAuthorizationError(
      `Authorization is for action "${String(auth.action)}", not "${params.action}".`,
    );
  }
  if (!isAgentId(auth.agentId)) {
    throw new OwnerAuthorizationError("agentId must be 2-64 chars of [a-z0-9_-].");
  }
  if (!isAddress(auth.agentAddress)) {
    throw new OwnerAuthorizationError("agentAddress must be a 20-byte hex address.");
  }
  if (!isAddress(auth.vault)) {
    throw new OwnerAuthorizationError("vault must be a 20-byte hex address.");
  }
  if (typeof auth.issuedAt !== "number" || !Number.isFinite(auth.issuedAt)) {
    throw new OwnerAuthorizationError("issuedAt must be a unix timestamp in seconds.");
  }
  if (typeof auth.nonce !== "string" || !/^[0-9a-f]{16,64}$/.test(auth.nonce)) {
    throw new OwnerAuthorizationError("nonce must be 16-64 hex characters.");
  }
  if (typeof params.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(params.signature)) {
    throw new OwnerAuthorizationError("signature must be a hex string.");
  }

  const age = Math.floor(Date.now() / 1000) - auth.issuedAt;
  if (age > MAX_SIGNATURE_AGE_SECONDS) {
    throw new OwnerAuthorizationError("Authorization has expired; sign it again.", 401);
  }
  if (age < -60) {
    throw new OwnerAuthorizationError("Authorization issuedAt is in the future.", 401);
  }

  const claimedVault = (auth.vault as string).toLowerCase();

  const message = credentialAuthorizationMessage({
    action: auth.action,
    agentId: auth.agentId,
    agentAddress: auth.agentAddress,
    vault: claimedVault as Address,
    issuedAt: auth.issuedAt,
    nonce: auth.nonce,
  });

  // Recover first, then ask the factory which vault that signer owns. Deriving authority from the
  // recovered address rather than from anything in the request is the whole point: there is no
  // server-side allowlist of operator addresses that could disagree with the chain.
  const signer = await recoverMessageAddress({message, signature: params.signature as `0x${string}`}).catch(
    () => null,
  );
  if (!signer) {
    throw new OwnerAuthorizationError("Signature could not be recovered.");
  }

  let factory: Address;
  let ownedVault: Address;
  try {
    factory = mandateFactory();
    ownedVault = (await publicClient.readContract({
      address: factory,
      abi: mandateVaultFactoryAbi,
      functionName: "vaultOf",
      args: [signer],
    })) as Address;
  } catch (e) {
    throw new OwnerAuthorizationError(
      `Could not read the factory: ${(e as Error).message}`,
      503,
    );
  }

  if (ownedVault.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new OwnerAuthorizationError(
      "That wallet has no vault. Create one before issuing agent keys.",
      409,
    );
  }

  // The signature named a vault; the chain says this signer owns a different one. Refuse rather
  // than silently acting on whichever vault the payload happened to carry.
  if (ownedVault.toLowerCase() !== claimedVault) {
    throw new OwnerAuthorizationError(
      `This signature names vault ${claimedVault} but the signer owns ${ownedVault}.`,
      403,
    );
  }

  // Confirm the factory's mapping agrees with the vault's own owner(). This is a cheap belt-and-
  // braces read: it means authority can only ever come from the vault itself.
  let vaultOwner: Address;
  try {
    vaultOwner = (await publicClient.readContract({
      address: ownedVault,
      abi: mandateVaultAbi,
      functionName: "owner",
    })) as Address;
  } catch (e) {
    throw new OwnerAuthorizationError(
      `Could not read the vault owner from the chain: ${(e as Error).message}`,
      503,
    );
  }
  if (vaultOwner.toLowerCase() !== signer.toLowerCase()) {
    throw new OwnerAuthorizationError("Signature does not match the vault owner on this chain.");
  }

  let registered = false;
  try {
    registered = Boolean(
      await publicClient.readContract({
        address: ownedVault,
        abi: mandateVaultAbi,
        functionName: "agents",
        args: [auth.agentAddress],
      }),
    );
  } catch (e) {
    throw new OwnerAuthorizationError(
      `Could not read agent registration: ${(e as Error).message}`,
      503,
    );
  }
  if (!registered) {
    throw new OwnerAuthorizationError(
      "That address is not a registered agent on this vault. Register it from the dashboard first.",
      409,
    );
  }

  return {
    agentId: auth.agentId,
    agentAddress: auth.agentAddress,
    vault: ownedVault,
    // Hashed so the stored replay guard holds no replayable authorization material.
    nonceHash: createHash("sha256")
      .update(`${auth.nonce}:${auth.action}:${auth.agentId}:${ownedVault.toLowerCase()}`)
      .digest("hex"),
  };
}