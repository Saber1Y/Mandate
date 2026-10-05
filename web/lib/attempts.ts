/**
 * Rejected-attempt log.
 *
 * Mandate's contract *reverts* when a request breaks policy. That is the right design for safety - a
 * refused spend leaves no state to reason about - but it has a consequence for observability: a
 * blocked attempt emits no event and costs no gas, so there is no on-chain evidence it ever happened.
 * An operator asking "why is my agent not spending?" therefore has nothing to read.
 *
 * So this table records attempts, never outcomes. It is written only when a relay has already been
 * rejected on-chain, and it stores what was *asked for* plus the decoded revert name. It cannot say a
 * payment happened, and nothing in the settlement path reads it: balances, policy, request status and
 * approvals are all still read from the chain. Deleting this entire table would lose the rejection
 * history and change no other behaviour.
 *
 * That distinction is the whole reason this is acceptable next to a codebase that keeps no financial
 * mirror. If this ever grows a "settled" column, it has become a second ledger and the invariant is
 * gone.
 */

import Database from "libsql";
import path from "node:path";

const TURSO_URL = process.env.TURSO_DATABASE_URL ?? "";
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN ?? "";
const DB_PATH = path.join(process.cwd(), "data", "mandate.db");
const isRemote = TURSO_URL.length > 0;

let _db: Database.Database | null = null;

export interface RejectedAttempt {
  id: number;
  vault: string;
  agent: string;
  agentId: string;
  recipient: string;
  amount: string;
  token: string;
  /** Decoded custom error from MandateVault, e.g. NotAuthorized or InvalidPolicy. */
  reason: string;
  /** Operator-facing sentence, so the UI never has to map error names to prose. */
  detail: string;
  createdAt: number;
}

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
    CREATE TABLE IF NOT EXISTS rejected_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault TEXT NOT NULL,
      agent TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      amount TEXT NOT NULL,
      token TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rejected_attempts_vault
      ON rejected_attempts (vault, created_at);
  `);
}

/**
 * Turn a decoded revert name into something an operator can act on.
 *
 * Kept next to the table so the meaning of a reason code is defined once. Unknown names fall through
 * to the raw name rather than being hidden, because a new contract error should be visible as itself.
 */
export function describeRejection(reason: string, detail?: string): string {
  switch (reason) {
    case "NotAuthorized":
      return "The agent may not pay this recipient, or the token is not allowlisted for it.";
    case "InvalidPolicy":
      return "The amount breaks a limit: over the per-transaction cap, over a daily cap, or the caps are unset.";
    case "NotRegistered":
      return "The agent is not registered or its policy is inactive on this vault.";
    case "InsufficientBalance":
      return "The vault does not hold enough of this token to cover the request.";
    case "ZeroAmount":
      return "The amount was zero.";
    case "DeadlinePassed":
      return "The agent's policy or this recipient's entry has expired.";
    case "IdempotencyConflict":
      return "That idempotency key was already used with different parameters.";
    case "RequestNotApproved":
      return "The request has not been approved yet, so it cannot settle.";
    case "RequestFinalized":
      return "The request already reached a terminal state.";
    case "UnknownRequest":
      return "The vault has no request with that id.";
    default:
      return detail ?? `The vault rejected the request (${reason}).`;
  }
}

export function recordRejectedAttempt(input: {
  vault: string;
  agent: string;
  agentId: string;
  recipient: string;
  amount: string;
  token: string;
  reason: string;
  detail?: string;
}): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO rejected_attempts
           (vault, agent, agent_id, recipient, amount, token, reason, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.vault,
        input.agent,
        input.agentId,
        input.recipient,
        input.amount,
        input.token,
        input.reason,
        describeRejection(input.reason, input.detail),
        Date.now(),
      );
  } catch {
    // Losing an observability row must never turn a clean 422 into a 500.
  }
}

export function listRejectedAttempts(limit = 25): RejectedAttempt[] {
  try {
    return getDb()
      .prepare(
        `SELECT id, vault, agent, agent_id AS agentId, recipient, amount, token, reason, detail,
                created_at AS createdAt
           FROM rejected_attempts ORDER BY id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(200, limit))) as unknown as RejectedAttempt[];
  } catch {
    return [];
  }
}