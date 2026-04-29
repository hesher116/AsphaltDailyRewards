const fs = require('fs/promises');
const config = require('./config');
const logger = require('./utils/logger');
const { createDb } = require('./storage/db');
const RewardsRepository = require('./storage/rewardsRepository');
const SessionRepository = require('./storage/sessionRepository');
const AuthFlow = require('./automation/authFlow');
const AsphaltCollector = require('./automation/asphaltCollector');
const RewardScheduler = require('./scheduler/rewardScheduler');
const StatusReporter = require('./status/statusReporter');
const Dashboard = require('./bot/dashboard');
const { createTelegramBot } = require('./bot/telegramBot');
const { registerBotHandlers } = require('./bot/botHandlers');
const { formatDateTime } = require('./utils/time');

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

  let dashboard;
  const scheduler = new RewardScheduler({
    collector,
    rewardsRepository,
    sessionRepository,
    notify: async (event) => {
      if (event.type !== 'collect_result') return;

      if (dashboard) {
        const status = event.result.status === 'success' || event.result.status === 'partial'
          ? 'Плановий збір завершено'
          : event.result.status === 'session_lost'
            ? 'Потрібна повторна авторизація'
            : 'Подарунки зараз недоступні';
        const rewards = (event.result.rewards || []).map((reward) => reward.name).join('; ') || 'нагороди не отримано';
        await dashboard.setStatus(
          status,
          {
            action: 'Плановий збір завершено',
            message: `Результат: ${rewards}. Наступний збір: ${formatDateTime(event.result.nextRunAt)}`
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

  scheduler.start();
  await dashboard.setStatus('Очікую команду', {
    action: 'Запуск системи',
    lastMessage: `Browser mode: HEADLESS=${config.browser.headless ? 'true' : 'false'}`
  });

  async function shutdown(signal) {
    logger.info('Завершую роботу програми');
    logger.debug({ signal }, 'Shutdown signal');
    scheduler.stop();
    dashboard.stop();
    await bot.stopPolling().catch(() => {});
    await authFlow.close();
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
