const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

function createDb() {
  fs.mkdirSync(path.dirname(config.storage.sqlitePath), { recursive: true });
  const db = new Database(config.storage.sqlitePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS reward_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      rewards_json TEXT NOT NULL DEFAULT '[]',
      image_paths_json TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL DEFAULT '',
      error TEXT,
      technical_status TEXT NOT NULL DEFAULT '',
      verified_at TEXT,
      collected_count INTEGER NOT NULL DEFAULT 0,
      expected_count INTEGER NOT NULL DEFAULT 0,
      verification_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS session_state (
      key TEXT PRIMARY KEY CHECK (key = 'main'),
      auth_status TEXT NOT NULL DEFAULT 'unknown',
      waiting_otp_since TEXT,
      last_successful_login_at TEXT,
      last_successful_collect_at TEXT,
      last_run_at TEXT,
      next_run_at TEXT,
      scheduler_offset_ms INTEGER NOT NULL DEFAULT 0,
      dashboard_message_id INTEGER,
      dashboard_chat_id TEXT,
      dashboard_recent_actions_json TEXT NOT NULL DEFAULT '[]',
      dashboard_recent_messages_json TEXT NOT NULL DEFAULT '[]',
      active_browser_session INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);

  const sessionColumns = db.prepare('PRAGMA table_info(session_state)').all().map((column) => column.name);
  if (!sessionColumns.includes('last_successful_collect_at')) {
    db.exec('ALTER TABLE session_state ADD COLUMN last_successful_collect_at TEXT');
  }
  if (!sessionColumns.includes('scheduler_offset_ms')) {
    db.exec('ALTER TABLE session_state ADD COLUMN scheduler_offset_ms INTEGER NOT NULL DEFAULT 0');
  }
  if (!sessionColumns.includes('dashboard_message_id')) {
    db.exec('ALTER TABLE session_state ADD COLUMN dashboard_message_id INTEGER');
  }
  if (!sessionColumns.includes('dashboard_chat_id')) {
    db.exec('ALTER TABLE session_state ADD COLUMN dashboard_chat_id TEXT');
  }
  if (!sessionColumns.includes('dashboard_recent_actions_json')) {
    db.exec("ALTER TABLE session_state ADD COLUMN dashboard_recent_actions_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!sessionColumns.includes('dashboard_recent_messages_json')) {
    db.exec("ALTER TABLE session_state ADD COLUMN dashboard_recent_messages_json TEXT NOT NULL DEFAULT '[]'");
  }

  const rewardColumns = db.prepare('PRAGMA table_info(reward_runs)').all().map((column) => column.name);
  if (!rewardColumns.includes('verified_at')) {
    db.exec('ALTER TABLE reward_runs ADD COLUMN verified_at TEXT');
  }
  if (!rewardColumns.includes('collected_count')) {
    db.exec('ALTER TABLE reward_runs ADD COLUMN collected_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!rewardColumns.includes('expected_count')) {
    db.exec('ALTER TABLE reward_runs ADD COLUMN expected_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!rewardColumns.includes('verification_json')) {
    db.exec("ALTER TABLE reward_runs ADD COLUMN verification_json TEXT NOT NULL DEFAULT '{}'");
  }

  db.prepare(`
    INSERT OR IGNORE INTO session_state (key, updated_at)
    VALUES ('main', datetime('now'))
  `).run();

  return db;
}

module.exports = {
  createDb
};
