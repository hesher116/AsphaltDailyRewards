const fs = require('fs/promises');
const path = require('path');
const config = require('../config');
const logger = require('./logger');

const GRACEFUL_FLAG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function gracefulShutdownFlagPath() {
  return path.join(config.storage.dataDir, 'graceful_shutdown.flag');
}

function lastSuccessfulCollectTimestampPath() {
  return path.join(config.storage.dataDir, 'last_successful_collect.timestamp');
}

function restartNotificationPath() {
  return path.join(config.storage.dataDir, 'restart_notification.json');
}

async function ensureDataDir() {
  await fs.mkdir(config.storage.dataDir, { recursive: true });
}

async function readTextFile(filePath) {
  return fs.readFile(filePath, 'utf8').catch(() => null);
}

async function writeJsonFile(filePath, data) {
  await ensureDataDir();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function writeGracefulShutdownFlag() {
  await writeJsonFile(gracefulShutdownFlagPath(), {
    at: new Date().toISOString()
  });
}

async function consumeGracefulShutdownFlag() {
  const raw = await readTextFile(gracefulShutdownFlagPath());
  if (!raw) return { graceful: false, reason: 'missing_flag' };

  await fs.unlink(gracefulShutdownFlagPath()).catch(() => {});

  try {
    const parsed = JSON.parse(raw);
    const at = new Date(parsed.at);
    if (Number.isNaN(at.getTime())) return { graceful: false, reason: 'invalid_flag' };
    if (Date.now() - at.getTime() > GRACEFUL_FLAG_MAX_AGE_MS) return { graceful: false, reason: 'stale_flag' };
    return { graceful: true, reason: 'graceful_shutdown' };
  } catch {
    return { graceful: false, reason: 'invalid_flag' };
  }
}

async function writeLastSuccessfulCollectTimestamp(isoDate) {
  await ensureDataDir();
  await fs.writeFile(lastSuccessfulCollectTimestampPath(), isoDate, 'utf8');
}

async function readLastSuccessfulCollectTimestamp() {
  const raw = await readTextFile(lastSuccessfulCollectTimestampPath());
  const trimmed = raw ? raw.trim() : '';
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function writeRestartNotification(messageId) {
  await writeJsonFile(restartNotificationPath(), {
    messageId,
    at: new Date().toISOString()
  });
}

async function clearRestartNotification() {
  await fs.unlink(restartNotificationPath()).catch(() => {});
}

function isPm2Runtime() {
  return Boolean(process.env.pm_id || process.env.PM2_HOME);
}

function hoursSince(isoDate) {
  if (!isoDate) return null;
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return null;
  return (Date.now() - date.getTime()) / (60 * 60 * 1000);
}

async function safeWriteLastCollect(isoDate) {
  try {
    await writeLastSuccessfulCollectTimestamp(isoDate);
  } catch (error) {
    logger.warn('Не вдалося записати timestamp останнього успішного збору');
    logger.debug({ error }, 'writeLastSuccessfulCollectTimestamp failed');
  }
}

module.exports = {
  consumeGracefulShutdownFlag,
  writeGracefulShutdownFlag,
  readLastSuccessfulCollectTimestamp,
  writeLastSuccessfulCollectTimestamp,
  writeRestartNotification,
  clearRestartNotification,
  isPm2Runtime,
  hoursSince,
  safeWriteLastCollect
};
