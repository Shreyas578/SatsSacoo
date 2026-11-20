import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export function createDatabase(dbPath: string = ':memory:'): Database.Database {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Initialize Tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      creator_tg_id INTEGER NOT NULL,
      contribution_sats INTEGER NOT NULL,
      cycle_interval_hours INTEGER NOT NULL,
      max_members INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'FORMING',
      current_cycle_index INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      tg_id INTEGER NOT NULL,
      tg_username TEXT,
      display_name TEXT NOT NULL,
      nostr_pubkey TEXT NOT NULL,
      lightning_address TEXT,
      rotation_index INTEGER,
      joined_at INTEGER NOT NULL,
      is_blacklisted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      UNIQUE (group_id, tg_id),
      UNIQUE (group_id, nostr_pubkey),
      UNIQUE (group_id, rotation_index)
    );

    CREATE TABLE IF NOT EXISTS cycles (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      cycle_index INTEGER NOT NULL,
      beneficiary_member_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'CYCLE_OPEN',
      pot_target_sats INTEGER NOT NULL,
      pot_collected_sats INTEGER NOT NULL DEFAULT 0,
      opened_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      payout_initiated_at INTEGER,
      payout_settled_at INTEGER,
      payout_preimage TEXT,
      payout_tx_id TEXT,
      payout_error TEXT,
      payout_in_progress INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (beneficiary_member_id) REFERENCES members(id),
      UNIQUE (group_id, cycle_index)
    );

    CREATE TABLE IF NOT EXISTS contributions (
      id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'PENDING',
      amount_sats INTEGER NOT NULL,
      invoice_bolt11 TEXT,
      payment_hash TEXT,
      payment_preimage TEXT,
      invoice_created_at INTEGER,
      invoice_expires_at INTEGER,
      paid_at INTEGER,
      late_grace_expires_at INTEGER,
      nostr_receipt_id TEXT,
      FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE CASCADE,
      FOREIGN KEY (member_id) REFERENCES members(id),
      UNIQUE (cycle_id, member_id),
      UNIQUE (payment_hash)
    );

    CREATE TABLE IF NOT EXISTS reputation_logs (
      id TEXT PRIMARY KEY,
      nostr_pubkey TEXT NOT NULL,
      group_id TEXT NOT NULL,
      cycle_id TEXT,
      event_type TEXT NOT NULL, -- 'PAID_ON_TIME', 'PAID_LATE', 'DEFAULTED', 'CYCLE_COMPLETED'
      nostr_event_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  return db;
}

