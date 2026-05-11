const fs = require('fs/promises');
const config = require('./config');
const logger = require('./utils/logger');
const { createDb } = require('./storage/db');
const RewardsRepository = require('./storage/rewardsRepository');
const SessionRepository = require('./storage/sessionRepository');
const AuthFlow = require('./automation/authFlow');
const AsphaltCollector = require('./automation/asphaltCollector');
const { buildCollectSummary, collectStatusTitle, isVerifiedCollect } = require('./automation/collectResult');
const RewardScheduler = require('./scheduler/rewardScheduler');
const StatusReporter = require('./status/statusReporter');
const Dashboard = require('./bot/dashboard');
const { createTelegramBot, deleteMessageSafe, sendMessageToChat } = require('./bot/telegramBot');
const { registerBotHandlers } = require('./bot/botHandlers');
const { formatDateTime } = require('./utils/time');
const {
  clearRestartNotification,
  consumeGracefulShutdownFlag,
  hoursSince,
  isPm2Runtime,
  readLastSuccessfulCollectTimestamp,
  safeWriteLastCollect,
  writeGracefulShutdownFlag,
  writeRestartNotification
} = require('./utils/runtimeState');

function validateConfig() {
  const missing = [];
  if (!config.telegram.token) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.asphalt.email) missing.push('ASPHALT_EMAIL');
  if (missing.length) throw new Error(`Missing required env values: ${missing.join(', ')}`);
}

async function ensureDataDirs() {
  await fs.mkdir(config.storage.dataDir, { recursive: true });
  await fs.mkdir(config.browser.profileDir, { recursive: true });
  await fs.mkdir(config.storage.rewardImagesDir, { recursive: true });
  await fs.mkdir(config.storage.debugSnapshotsDir, { recursive: true });
}

async function notifyPm2RestartIfNeeded(bot) {
  const restartState = await consumeGracefulShutdownFlag();
  if (restartState.graceful || !isPm2Runtime()) return null;

  const sent = await sendMessageToChat(
    bot,
    config.telegram.chatId,
    [
      '⚠️ Сервер перезапустився',
      `Час: ${formatDateTime(new Date())}`,
      'Причина: PM2 restart detected',
      'Статус: Працює нормально'
    ].join('\n')
  );

  if (!sent || !sent.message_id) return null;

  await writeRestartNotification(sent.message_id);
  logger.warn('PM2 restart detected, temporary Telegram notification sent');

  const ttlMs = config.runtime.restartNotificationTtlHours * 60 * 60 * 1000;
  return setTimeout(async () => {
    await deleteMessageSafe(bot, config.telegram.chatId, sent.message_id);
    await clearRestartNotification();
  }, ttlMs);
}

async function getLastSuccessfulCollectIso(sessionRepository) {
  const fileTimestamp = await readLastSuccessfulCollectTimestamp();
  if (fileTimestamp) return fileTimestamp;

  const dbTimestamp = sessionRepository.getState().lastSuccessfulCollectAt;
  if (dbTimestamp) {
    await safeWriteLastCollect(dbTimestamp);
    return dbTimestamp;
  }
  return null;
}

function hasUpcomingScheduledRun(sessionRepository) {
  const nextRunAt = sessionRepository.getState().nextRunAt;
  if (!nextRunAt) return false;
  const date = new Date(nextRunAt);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() > Date.now() && date.getTime() - Date.now() <= 10 * 60 * 1000;
}

async function runStartupAutoCollectIfNeeded({ scheduler, sessionRepository, dashboard }) {
  const lastCollectIso = await getLastSuccessfulCollectIso(sessionRepository);
  const ageHours = hoursSince(lastCollectIso);
  if (ageHours === null) return;
  if (ageHours * 60 * 60 * 1000 <= config.runtime.startupAutoCollectThresholdMs) return;

  if (hasUpcomingScheduledRun(sessionRepository)) {
    logger.info('Наступний збір уже заплановано найближчим часом, startup auto-collect пропущено');
    return;
  }

  logger.info(`Останній збір був ${ageHours.toFixed(1)} годин тому, запускаю негайно`);
  await dashboard.setStatus('Запускаю збір після рестарту', {
    action: 'Startup auto-collect',
    message: `Останній збір був ${ageHours.toFixed(1)} годин тому, запускаю негайно`
  });

  const result = await scheduler.runStartupCollect();
  if (isVerifiedCollect(result.status)) {
    await dashboard.setStatus('Startup збір завершено', {
      action: 'Startup auto-collect завершено',
      message: `Наступний збір: ${formatDateTime(result.nextRunAt)}`
    });
    return;
  }

  await dashboard.setStatus('Startup збір не вдався', {
    action: 'Startup auto-collect не вдався',
    message: `Scheduler залишено без змін. Наступний збір: ${formatDateTime(result.nextRunAt)}`
  });
}

async function bootstrap() {
  validateConfig();
  await ensureDataDirs();

  const db = createDb();
  const rewardsRepository = new RewardsRepository(db);
  const sessionRepository = new SessionRepository(db);
  const statusReporter = new StatusReporter();
  const authFlow = new AuthFlow(sessionRepository, statusReporter);
  const collector = new AsphaltCollector(authFlow, sessionRepository, statusReporter);
  const bot = await createTelegramBot();
  let restartNotificationTimer = await notifyPm2RestartIfNeeded(bot);

  let dashboard;
  const scheduler = new RewardScheduler({
    collector,
    rewardsRepository,
    sessionRepository,
    notify: async (event) => {
      if (event.type === 'info' && dashboard) {
        await dashboard.setStatus(event.text, {
          action: event.text,
          message: event.text
        });
        return;
      }

      if (event.type === 'heartbeat' && dashboard) {
        await dashboard.setStatus('Очікую плановий збір', {
          action: 'Heartbeat',
          message: event.text
        });
        return;
      }

      if (event.type !== 'collect_result') return;

      if (dashboard) {
        const status = collectStatusTitle(event.result, true);
        await dashboard.setStatus(
          status,
          {
            action: status,
            message: buildCollectSummary(event.result, event.result.nextRunAt, { scheduled: true })
          }
        );
      }
    }
  });

  dashboard = new Dashboard({
    bot,
    statusReporter,
    sessionRepository,
    scheduler
  });
  dashboard.start();

  registerBotHandlers({
    bot,
    authFlow,
    scheduler,
    rewardsRepository,
    sessionRepository,
    dashboard
  });

  await dashboard.setStatus('Очікую команду', {
    action: 'Запуск системи',
    message: `Browser mode: HEADLESS=${config.browser.headless ? 'true' : 'false'}`
  });

  await runStartupAutoCollectIfNeeded({ scheduler, sessionRepository, dashboard });
  scheduler.start();

  async function shutdown(signal) {
    logger.info('Завершую роботу програми');
    logger.debug({ signal }, 'Shutdown signal');
    if (restartNotificationTimer) {
      clearTimeout(restartNotificationTimer);
      restartNotificationTimer = null;
    }
    scheduler.stop();
    dashboard.stop();
    await bot.stopPolling().catch(() => {});
    await authFlow.close();
    await writeGracefulShutdownFlag();
    db.close();
    process.exit(0);
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      logger.error('Не вдалося коректно завершити роботу');
      logger.debug({ error }, 'Shutdown failed');
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      logger.error('Не вдалося коректно завершити роботу');
      logger.debug({ error }, 'Shutdown failed');
      process.exit(1);
    });
  });
}

bootstrap().catch((error) => {
  logger.error('Критична помилка запуску програми');
  logger.debug({ error }, 'Fatal startup error');
  process.exit(1);
});
