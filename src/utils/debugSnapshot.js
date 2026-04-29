const fs = require('fs/promises');
const path = require('path');
const config = require('../config');
const logger = require('./logger');
const { ensureDir } = require('./fileCleanup');

async function savePageSnapshot(page, reason) {
  if (!page) return null;

  try {
    const dir = config.storage.debugSnapshotsDir;
    await ensureDir(dir);
    const safeReason = String(reason || 'snapshot').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40);
    const filePath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeReason}.html`);
    await fs.writeFile(filePath, await page.content(), 'utf8');
    logger.debug({ filePath }, 'Saved debug page snapshot');
    return filePath;
  } catch (error) {
    logger.debug({ error }, 'Failed to save debug page snapshot');
    return null;
  }
}

module.exports = {
  savePageSnapshot
};
