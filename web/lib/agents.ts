import Database from "libsql";
import path from "node:path";
import {generateAgentKey, hashAgentKey, type AgentCredential} from "./auth";

/**
 * Credential store for agent API keys.
 *
 * This is the only thing Mandate still keeps server-side, and it stores secrets, not money. Every
 * policy, balance, cap and request status is read from the chain instead, so there is no mirror to
 * drift out of sync and no server-side record that can disagree with what funds actually did.
 *
 * Amounts are deliberately absent here. If you are tempted to add a `spent_today` column to make
 * queries easier, that is the SpendArc bug coming back: the contract is the ledger.
 */

const TURSO_URL = process.env.TURSO_DATABASE_URL ?? "";
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN ?? "";
const DB_PATH = path.join(process.cwd(), "data", "mandate.db");
const isRemote = TURSO_URL.length > 0;

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    if (isRemote) {
      _db = new Database(TURSO_URL, {authToken: TURSO_AUTH_TOKEN} as Database.Options);
    } else {
      const fs = require("fs");
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
      _db = new Database(DB_PATH);
      _db.pragma("journal_mode = WAL");
    }
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_credentials (
      key_hash TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_address TEXT NOT NULL,
      key_hint TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_credentials_agent
      ON agent_credentials (agent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_credentials_active_address
      ON agent_credentials (agent_address) WHERE revoked = 0;

    -- Owner-signed authorizations are single-use. Storing the nonce makes a captured signature
    -- replayable for nothing, even inside its 5-minute validity window.
    CREATE TABLE IF NOT EXISTS credential_authorizations (
      nonce_hash TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

function rowToCredential(row: Record<string, unknown>): AgentCredential {
  return {
    agentId: String(row.agent_id),
    agentAddress: String(row.agent_address) as AgentCredential["agentAddress"],
    keyHash: String(row.key_hash),
    keyHint: String(row.key_hint),
    revoked: Number(row.revoked) === 1,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    lastUsedAt: row.last_used_at == null ? null : new Date(Number(row.last_used_at)).toISOString(),
  };
}

/** Match on key hash only. Revoked rows are returned so auth can distinguish revoked from unknown. */
export async function findCredentialByHash(keyHash: string): Promise<AgentCredential | null> {
  const row = getDb()
    .prepare("SELECT * FROM agent_credentials WHERE key_hash = ?")
    .get(keyHash) as Record<string, unknown> | undefined;
  return row ? rowToCredential(row) : null;
}

/**
 * Issue a new key for an agent. The plaintext is returned exactly once and is never stored, so a
 * lost key can only be replaced by rotation, never recovered.
 */
export async function issueAgentKey(params: {
  agentId: string;
  agentAddress: string;
}): Promise<{credential: AgentCredential; plaintext: string}> {
  const {plaintext, keyHash, keyHint} = generateAgentKey();
  const createdAt = Date.now();
  const address = params.agentAddress.toLowerCase();
  try {
    getDb()
      .prepare(
        `INSERT INTO agent_credentials (key_hash, agent_id, agent_address, key_hint, revoked, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(keyHash, params.agentId, address, keyHint, createdAt);
  } catch (e) {
    // One live key per agent address is a deliberate invariant: a second live key for the same
    // address doubles the blast radius of a leak without adding any capability.
    if (String(e).includes("UNIQUE constraint failed: agent_credentials.agent_address")) {
      throw new Error(
        "That agent address already has an active key. Use rotate to replace it, or revoke first.",
      );
    }
    throw e;
  }

  return {
    plaintext,
    credential: {
      agentId: params.agentId,
      agentAddress: address as AgentCredential["agentAddress"],
      keyHash,
      keyHint,
      revoked: false,
      createdAt: new Date(createdAt).toISOString(),
      lastUsedAt: null,
    },
  };
}

/**
 * Rotate: revoke every existing key for the agent and issue a fresh one. Single-step rotation means
 * an operator can never end up with an unknown number of live keys.
 */
export async function rotateAgentKeys(agentId: string): Promise<{credential: AgentCredential; plaintext: string}> {
  const db = getDb();
  db.prepare("UPDATE agent_credentials SET revoked = 1 WHERE agent_id = ? AND revoked = 0").run(agentId);
  const row = db
    .prepare("SELECT agent_address FROM agent_credentials WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(agentId) as {agent_address?: string} | undefined;

  const agentAddress =
    row?.agent_address ??
    (db.prepare("SELECT agent_address FROM agent_credentials WHERE agent_id = ?").get(agentId) as
      | {agent_address?: string}
      | undefined)?.agent_address;

  if (!agentAddress) throw new Error(`No credential exists for agent ${agentId}; cannot rotate.`);
  return issueAgentKey({agentId, agentAddress});
}

/** Revoke every key for an agent. The agent can no longer call the API, but its on-chain policy is untouched. */
export async function revokeAgentKeys(agentId: string): Promise<number> {
  const result = getDb()
    .prepare("UPDATE agent_credentials SET revoked = 1 WHERE agent_id = ? AND revoked = 0")
    .run(agentId);
  return Number(result.changes ?? 0);
}


/**
 * Record a credential-authorization nonce, rejecting a second use.
 *
 * Returns false when the nonce was already consumed. Callers must check this BEFORE minting a key:
 * the alternative is a replayed rotate signature silently revoking the key the owner just issued.
 */
export function claimAuthorizationNonce(params: {
  nonceHash: string;
  action: string;
  agentId: string;
}): boolean {
  try {
    const result = getDb()
      .prepare(
        `INSERT OR IGNORE INTO credential_authorizations (nonce_hash, action, agent_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(params.nonceHash, params.action, params.agentId, Date.now());
    // changes === 1 means this insert won the primary-key race. A replayed nonce reports 0 and is
    // rejected, so the same owner signature cannot be spent twice inside its validity window.
    return Number(result.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

/** Best-effort usage stamp. Failures here must never block an authenticated request. */
export function touchCredential(keyHash: string): void {
  try {
    getDb().prepare("UPDATE agent_credentials SET last_used_at = ? WHERE key_hash = ?").run(Date.now(), keyHash);
  } catch {
    // ignore
  }
}

export {hashAgentKey};
