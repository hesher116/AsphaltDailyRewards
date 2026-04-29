const fs = require('fs/promises');
const path = require('path');
const logger = require('./logger');

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function removeOldFiles(rootDir, olderThanDays) {
  await ensureDir(rootDir);
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await removeOldFiles(fullPath, olderThanDays);
      const remains = await fs.readdir(fullPath).catch(() => []);
      if (remains.length === 0) {
        await fs.rmdir(fullPath).catch(() => {});
      }
      continue;
    }

    const stat = await fs.stat(fullPath).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fs.unlink(fullPath).catch((error) => {
        logger.warn('Не вдалося видалити старе зображення подарунка');
        logger.debug({ error, fullPath }, 'Failed to delete old reward image');
      });
    }
  }
}

module.exports = {
  ensureDir,
  removeOldFiles
};
