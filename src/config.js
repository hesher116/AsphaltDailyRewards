const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

function boolFromEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function intFromEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolvePath(value, fallback) {
  return path.resolve(process.cwd(), value || fallback);
}

function listFromEnv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const dataDir = resolvePath(process.env.DATA_DIR, './data');

module.exports = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || ''
  },
  asphalt: {
    email: process.env.ASPHALT_EMAIL || '',
    shopUrl: process.env.SHOP_URL || 'https://shop.gameloft.com/games/Asphalt_Legends'
  },
  browser: {
    engine: (process.env.BROWSER_ENGINE || 'chromium').toLowerCase(),
    headless: boolFromEnv(process.env.HEADLESS, false),
    profileDir: resolvePath(process.env.BROWSER_PROFILE_DIR, path.join(dataDir, 'browser-profile')),
    viewport: {
      width: intFromEnv(process.env.VIEWPORT_WIDTH, 1366),
      height: intFromEnv(process.env.VIEWPORT_HEIGHT, 768)
    },
    locale: process.env.BROWSER_LOCALE || 'en-US',
    timezoneId: process.env.BROWSER_TIMEZONE || 'Europe/Paris',
    userAgent: process.env.BROWSER_USER_AGENT || '',
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH || '',
    extraArgs: listFromEnv(process.env.BROWSER_EXTRA_ARGS || process.env.CHROMIUM_EXTRA_ARGS)
  },
  storage: {
    dataDir,
    sqlitePath: resolvePath(process.env.SQLITE_PATH, path.join(dataDir, 'asphalt.sqlite')),
    rewardImagesDir: resolvePath(process.env.REWARD_IMAGES_DIR, path.join(dataDir, 'reward-images')),
    debugSnapshotsDir: resolvePath(process.env.DEBUG_SNAPSHOTS_DIR, path.join(dataDir, 'debug-snapshots')),
    imageRetentionDays: intFromEnv(process.env.IMAGE_RETENTION_DAYS, 3),
    debugSnapshotRetentionDays: intFromEnv(process.env.DEBUG_SNAPSHOT_RETENTION_DAYS, 7)
  },
  runtime: {
    debug: boolFromEnv(process.env.DEBUG, false),
    restartNotificationTtlHours: intFromEnv(process.env.RESTART_NOTIFICATION_TTL_HOURS, 6),
    heartbeatIntervalHours: intFromEnv(process.env.HEARTBEAT_INTERVAL_HOURS, 6),
    startupAutoCollectThresholdMs: (24 * 60 + 10) * 60 * 1000,
    navigationTimeoutMs: intFromEnv(process.env.NAVIGATION_TIMEOUT_MS, 60000),
    selectorTimeoutMs: intFromEnv(process.env.SELECTOR_TIMEOUT_MS, 15000),
    claimTimeoutMs: intFromEnv(process.env.CLAIM_TIMEOUT_MS, 8000),
    rewardRetryCount: intFromEnv(process.env.REWARD_RETRY_COUNT, 2),
    rewardRetryDelayMs: intFromEnv(process.env.REWARD_RETRY_DELAY_MS, 120000),
    maxRewardsPerCollect: intFromEnv(process.env.MAX_REWARDS_PER_COLLECT, 5)
  },
  scheduler: {
    baseDelayMs: 24 * 60 * 60 * 1000,
    minJitterMs: 60 * 1000,
    maxJitterMs: 300 * 1000,
    startupDelayMs: 5000
  }
};
