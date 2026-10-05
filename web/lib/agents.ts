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
      vault TEXT NOT NULL DEFAULT '',
      key_hint TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );

    -- Owner-signed authorizations are single-use. Storing the nonce makes a captured signature
    -- replayable for nothing, even inside its 5-minute validity window.
    CREATE TABLE IF NOT EXISTS credential_authorizations (
      nonce_hash TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // Order matters. An existing database still has the pre-multi-tenant table without a `vault`
  // column, so anything that references `vault` - including CREATE INDEX - fails until the migration
  // below has added it. Migrating first keeps a booted server from throwing on every request.
  migrateAgentCredentials(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_credentials_agent
      ON agent_credentials (agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_credentials_vault
      ON agent_credentials (vault);
  `);
}

/**
 * Bring a pre-multi-tenant database up to the current schema.
 *
 * The old unique index allowed exactly one live key per agent address across the whole deployment.
 * That was only ever correct because there was a single vault: once a second org onboarded, two
 * unrelated orgs could collide on the same agent address. The replacement index is per (vault,
 * address), so the invariant that matters - one live key per agent per treasury - is preserved.
 *
 * Migrations are idempotent so this runs safely on every boot.
 */
function migrateAgentCredentials(db: Database.Database) {
  const columns = db.prepare("PRAGMA table_info(agent_credentials)").all() as {
    name: string;
  }[];
  const hasVault = columns.some((c) => c.name === "vault");
  if (!hasVault) {
    db.exec("ALTER TABLE agent_credentials ADD COLUMN vault TEXT NOT NULL DEFAULT ''");
  }

  // NOTE: libsql's `.get()` returns undefined for a missing row, not null. Checking `!== null` here
  // would be true on a fresh database and silently skip creating the unique index, leaving agent
  // keys unconstrained. Truthiness is the only correct test for this driver.
  const hasVaultScopedIndex = Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_credentials_active_vault_address'")
      .get(),
  );
  if (!hasVaultScopedIndex) {
    db.exec("DROP INDEX IF EXISTS idx_agent_credentials_active_address");
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_credentials_active_vault_address
         ON agent_credentials (vault, agent_address) WHERE revoked = 0`,
    );
  }

  // Rows created before multi-tenancy have an empty vault. They belong to the single vault this
  // deployment shipped with, so backfill them from the legacy env var rather than stranding every
  // existing agent key. If the var is absent the row stays empty and simply stops authenticating,
  // which is the safe direction to fail in.
  const legacyVault = process.env.MANDATE_VAULT_ADDRESS;
  if (legacyVault && /^0x[0-9a-fA-F]{40}$/.test(legacyVault)) {
    db.prepare("UPDATE agent_credentials SET vault = ? WHERE vault = '' OR vault IS NULL").run(
      legacyVault.toLowerCase(),
    );
  }
}

function rowToCredential(row: Record<string, unknown>): AgentCredential {
  return {
    agentId: String(row.agent_id),
    agentAddress: String(row.agent_address) as AgentCredential["agentAddress"],
    vault: String(row.vault ?? "") as AgentCredential["vault"],
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
  vault: string;
}): Promise<{credential: AgentCredential; plaintext: string}> {
  const {plaintext, keyHash, keyHint} = generateAgentKey();
  const createdAt = Date.now();
  const address = params.agentAddress.toLowerCase();
  const vault = params.vault.toLowerCase();
  try {
    getDb()
      .prepare(
        `INSERT INTO agent_credentials (key_hash, agent_id, agent_address, vault, key_hint, revoked, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(keyHash, params.agentId, address, vault, keyHint, createdAt);
  } catch (e) {
    // One live key per agent per vault is a deliberate invariant: a second live key for the same
    // address doubles the blast radius of a leak without adding any capability.
    if (String(e).includes("UNIQUE constraint failed")) {
      throw new Error(
        "That agent address already has an active key on this vault. Use rotate to replace it, or revoke first.",
      );
    }
    throw e;
  }

  return {
    plaintext,
    credential: {
      agentId: params.agentId,
      agentAddress: address as AgentCredential["agentAddress"],
      vault: vault as AgentCredential["vault"],
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
export async function rotateAgentKeys(params: {
  agentId: string;
  vault: string;
}): Promise<{credential: AgentCredential; plaintext: string}> {
  const {agentId, vault} = params;
  const db = getDb();
  const v = vault.toLowerCase();
  // Scoped to one vault: revoking "research-agent" on org A's treasury must not touch org B's key
  // for an agent that happens to share the id.
  db.prepare("UPDATE agent_credentials SET revoked = 1 WHERE agent_id = ? AND vault = ? AND revoked = 0").run(
    agentId,
    v,
  );
  const row = db
    .prepare(
      "SELECT agent_address FROM agent_credentials WHERE agent_id = ? AND vault = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(agentId, v) as {agent_address?: string} | undefined;

  const agentAddress =
    row?.agent_address ??
    (db
      .prepare("SELECT agent_address FROM agent_credentials WHERE agent_id = ? AND vault = ?")
      .get(agentId, v) as {agent_address?: string} | undefined)?.agent_address;

  if (!agentAddress) throw new Error(`No credential exists for agent ${agentId} on this vault; cannot rotate.`);
  return issueAgentKey({agentId, agentAddress, vault: v});
}

/** Revoke every key for an agent on one vault. The agent can no longer call the API, but its on-chain policy is untouched. */
export async function revokeAgentKeys(params: {agentId: string; vault: string}): Promise<number> {
  const result = getDb()
    .prepare("UPDATE agent_credentials SET revoked = 1 WHERE agent_id = ? AND vault = ? AND revoked = 0")
    .run(params.agentId, params.vault.toLowerCase());
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
