import {createHash, randomBytes, timingSafeEqual} from "node:crypto";
import type {Address} from "viem";

/**
 * Agent authentication.
 *
 * Mandate agents are machine callers, so they authenticate with bearer API keys. Three properties
 * are mandatory for mainnet:
 *
 *  1. Keys are stored only as SHA-256 hashes. A database leak cannot be replayed against the API.
 *  2. Comparison is constant-time, so a timing side channel cannot recover a hash byte by byte.
 *  3. Keys are rotatable and revocable, and the agent's on-chain address is carried in the
 *     credential - never taken from the request body.
 *
 * The single most important rule in this file: the caller-supplied `agent` address is NEVER used to
 * decide who the caller is. It is read from the authenticated credential. That is what stops a
 * caller from spending another agent's allowance.
 */

export interface AgentCredential {
  /** Stable agent id. */
  agentId: string;
  /** On-chain address this key may act as. Must be a registered agent on the vault. */
  agentAddress: Address;
  /**
   * The vault this key is scoped to, resolved from the signing owner's `vaultOf` at issue time.
   *
   * This is what makes the credential single-tenant. Without it the API would have to guess which
   * vault the caller means, and a key issued by org A could be replayed against org B's vault if the
   * same agent address happened to be registered on both.
   */
  vault: Address;
  /** SHA-256 of the key, hex. The only thing persisted. */
  keyHash: string;
  /** Last few characters, so an operator can identify a key without storing it. */
  keyHint: string;
  revoked: boolean;
  createdAt: string;
  lastUsedAt?: string | null;
}

export class AuthenticationError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthenticationError";
    this.status = status;
  }
}

/** Prefix makes keys greppable in logs and impossible to confuse with other bearer tokens. */
const KEY_PREFIX = "mdt_";

export function generateAgentKey(): {plaintext: string; keyHash: string; keyHint: string} {
  const plaintext = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const keyHash = hashAgentKey(plaintext);
  return {plaintext, keyHash, keyHint: plaintext.slice(-6)};
}

/** SHA-256 hex. Deterministic so a presented key can be looked up by hash. */
export function hashAgentKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Constant-time hash comparison. Both sides are hashed first so lengths never leak. */
export function verifyAgentKey(plaintext: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashAgentKey(plaintext), "hex");
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, "hex");
  } catch {
    return false;
  }
  if (actual.length !== expected.length || expected.length === 0) return false;
  return timingSafeEqual(actual, expected);
}

/** Extract a bearer token from the Authorization header. Returns null when absent or malformed. */
export function extractBearerKey(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Resolve the caller's identity from a bearer key.
 *
 * `lookup` is injected so this module owns the crypto and the rules, while storage stays with the
 * caller. It MUST match on key hash only, and MUST return revoked credentials too so we can answer
 * "revoked" instead of "unknown key" without a timing difference.
 */
export async function authenticateAgent(
  request: Request,
  lookup: (keyHash: string) => Promise<AgentCredential | null>,
): Promise<AgentCredential> {
  const token = extractBearerKey(request);
  if (!token) {
    throw new AuthenticationError("Missing bearer API key. Send `Authorization: Bearer <key>`.");
  }

  const credential = await lookup(hashAgentKey(token));
  if (!credential) throw new AuthenticationError("Invalid API key.");
  if (credential.revoked) throw new AuthenticationError("API key has been revoked.", 403);

  if (!/^0x[0-9a-fA-F]{40}$/.test(credential.agentAddress)) {
    // A malformed credential is a server-side data problem, not a caller problem. Fail loudly
    // rather than falling through to an unauthenticated path.
    throw new AuthenticationError("Credential has an invalid agent address.", 500);
  }

  return credential;
}