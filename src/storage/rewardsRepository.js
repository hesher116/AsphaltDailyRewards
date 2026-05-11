const { nowIso } = require('../utils/time');

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

class RewardsRepository {
  constructor(db) {
    this.db = db;
  }

  addRun({ status, rewards = [], imagePaths = [], description = '', error = null, technicalStatus = '' }) {
    const info = this.db.prepare(`
      INSERT INTO reward_runs (
        created_at,
        status,
        rewards_json,
        image_paths_json,
        description,
        error,
        technical_status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      nowIso(),
      status,
      JSON.stringify(rewards),
      JSON.stringify(imagePaths),
      description,
      error,
      technicalStatus
    );

    return this.getById(info.lastInsertRowid);
  }

  getById(id) {
    const row = this.db.prepare('SELECT * FROM reward_runs WHERE id = ?').get(id);
    return row ? this.mapRow(row) : null;
  }

  getLast() {
    const row = this.db.prepare('SELECT * FROM reward_runs ORDER BY id DESC LIMIT 1').get();
    return row ? this.mapRow(row) : null;
  }

  getRecent(limit = 10) {
    return this.db
      .prepare('SELECT * FROM reward_runs ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((row) => this.mapRow(row));
  }

  getRecentSuccessful(limit = 3) {
    return this.db
      .prepare("SELECT * FROM reward_runs WHERE status IN ('success', 'needs_review', 'partial') ORDER BY id DESC LIMIT ?")
      .all(limit)
      .map((row) => this.mapRow(row));
  }

  mapRow(row) {
    return {
      id: row.id,
      createdAt: row.created_at,
      status: row.status,
      rewards: parseJson(row.rewards_json, []),
      imagePaths: parseJson(row.image_paths_json, []),
      description: row.description,
      error: row.error,
      technicalStatus: row.technical_status
    };
  }
}

module.exports = RewardsRepository;
