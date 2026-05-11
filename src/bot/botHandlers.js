const config = require('../config');
const fsPromises = require('fs/promises');
const path = require('path');
const logger = require('../utils/logger');
const { formatDateTime } = require('../utils/time');
const { findAvailableRewards } = require('../automation/rewardParser');
const selectors = require('../automation/selectors');
const { sendDocumentToChat, sendMessageToChat } = require('./telegramBot');
const { buildCollectSummary, collectStatusTitle } = require('../automation/collectResult');

const CALLBACK_COOLDOWN_MS = 1200;

const CALLBACK_LABELS = {
  dashboard: 'dashboard',
  commands: 'commands',
  cmd_doctor: 'cmd_doctor',
  cmd_verify_shop: 'cmd_verify_shop',
  cmd_logs: 'cmd_logs',
  cmd_snapshot: 'cmd_snapshot',
  cmd_next: 'cmd_next',
  cmd_images: 'cmd_images',
  login: 'login',
  check_session: 'check_session',
  collect: 'collect',
  status: 'status',
  history: 'history',
  recent_collects: 'recent_collects',
  help: 'help'
};

function isAdminChat(chatId) {
  return Boolean(config.telegram.chatId) && String(chatId) === String(config.telegram.chatId);
}

async function deleteUserMessage(bot, msg) {
  await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
}

async function listFilesRecursive(dir) {
  const entries = await fsPromises.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath));
    } else {
      const stat = await fsPromises.stat(fullPath).catch(() => null);
      if (stat) files.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return files;
}

function tailLines(text, limit) {
  return String(text || '').split(/\r?\n/).slice(-limit).join('\n');
}

function codeBlock(text) {
  const value = String(text || '').trim() || 'empty';
  return `\`\`\`\n${value.slice(-3500)}\n\`\`\``;
}

async function guardAdmin(bot, msgOrQuery) {
  const chatId = msgOrQuery.message ? msgOrQuery.message.chat.id : msgOrQuery.chat.id;
  if (isAdminChat(chatId)) return true;

  const text = msgOrQuery.text || msgOrQuery.data || '';
  if (text === '/start') {
    await sendMessageToChat(
      bot,
      chatId,
      `Цей chat id: ${chatId}\nЗапиши його в .env як TELEGRAM_CHAT_ID=${chatId}, потім перезапусти програму.`
    );
    return false;
  }

  await sendMessageToChat(bot, chatId, 'Доступ заборонено. Надішли /start, щоб побачити chat id.');
  return false;
}

function rewardLines(rewards) {
  if (!rewards || rewards.length === 0) return 'Нагороди не отримано.';
  return rewards.map((reward, index) => `${index + 1}. ${reward.name}`).join('\n');
}

function formatRun(run) {
  if (!run) return 'Історія поки порожня.';
  const error = run.error ? ` Помилка: ${run.error}` : '';
  return `#${run.id} ${formatDateTime(run.createdAt)} - ${run.status}: ${rewardLines(run.rewards).replace(/\n/g, '; ')}${error}`;
}

function formatStatus(sessionRepository, scheduler) {
  const state = sessionRepository.getState();
  return [
    `Авторизація: ${state.authStatus}`,
    `Браузер: ${state.activeBrowserSession ? 'активний' : 'закритий'}`,
    `Останній вхід: ${formatDateTime(state.lastSuccessfulLoginAt)}`,
    `Останній успішний збір: ${formatDateTime(state.lastSuccessfulCollectAt)}`,
    `Останній запуск: ${formatDateTime(state.lastRunAt)}`,
    `Наступний запуск: ${formatDateTime(state.nextRunAt)}`,
    `Збір зараз: ${scheduler.isRunning() ? 'виконується' : 'не виконується'}`
  ].join(' | ');
}

function formatDoctor(ctx) {
  const state = ctx.sessionRepository.getState();
  const lastRun = ctx.rewardsRepository.getLast();
  const polling = typeof ctx.bot.getPollingHealth === 'function'
    ? ctx.bot.getPollingHealth()
    : {};
  const memory = process.memoryUsage();
  const lastError = polling.lastError
    ? `${polling.lastError.kind}: ${polling.lastError.description}`
    : 'немає';

  return [
    'Doctor',
    `PM2: ${process.env.PM2_HOME ? 'так' : 'невідомо'}`,
    `Uptime: ${Math.round(process.uptime() / 60)} хв`,
    `Memory RSS: ${Math.round(memory.rss / 1024 / 1024)} MB`,
    `Auth: ${state.authStatus}`,
    `Browser: ${state.activeBrowserSession ? 'active' : 'closed'}`,
    `Collect running: ${ctx.scheduler.isRunning() ? 'yes' : 'no'}`,
    `Last run: ${lastRun ? `${formatDateTime(lastRun.createdAt)} ${lastRun.status} ${lastRun.collectedCount}/${lastRun.expectedCount}` : 'немає'}`,
    `Verified at: ${formatDateTime(lastRun && lastRun.verifiedAt)}`,
    `Next run: ${formatDateTime(state.nextRunAt)}`,
    `Polling: ${polling.polling ? 'on' : 'off'}, errors=${polling.errorStreak || 0}`,
    `Polling last success: ${formatDateTime(polling.lastSuccessAt)}`,
    `Polling last error: ${lastError}`
  ].join('\n');
}

async function latestDebugSnapshot() {
  const files = await listFilesRecursive(config.storage.debugSnapshotsDir);
  return files
    .filter((file) => /\.(html?|txt)$/i.test(file.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

async function readPm2Logs(lines = 30) {
  const pm2Home = process.env.PM2_HOME || path.join(process.env.HOME || '.', '.pm2');
  const outPath = path.join(pm2Home, 'logs', 'asphalt-daily-rewards-out-0.log');
  const errPath = path.join(pm2Home, 'logs', 'asphalt-daily-rewards-error-0.log');
  const [outLog, errLog] = await Promise.all([
    fsPromises.readFile(outPath, 'utf8').catch(() => ''),
    fsPromises.readFile(errPath, 'utf8').catch(() => '')
  ]);

  return [
    `OUT ${outPath}`,
    tailLines(outLog, lines),
    '',
    `ERROR ${errPath}`,
    tailLines(errLog, lines)
  ].join('\n').trim();
}

function logButtonPress(query) {
  const action = CALLBACK_LABELS[query.data] || query.data || 'unknown';
  logger.info(`Telegram button pressed: ${action}`);
}

async function withActionLock(ctx, actionName, action) {
  if (ctx.actionRunning) {
    await ctx.dashboard.setStatus('Інша дія вже виконується', {
      action: actionName,
      message: 'Зачекай завершення поточної операції'
    });
    return;
  }

  ctx.actionRunning = true;
  await ctx.dashboard.setBusy(true, actionName);
  try {
    await action();
  } finally {
    ctx.actionRunning = false;
    await ctx.dashboard.setBusy(false);
  }
}

async function showHelp(ctx) {
  await ctx.dashboard.setStatus('Допомога', {
    action: 'Відкрито допомогу',
    message: 'Кнопки керують усіма діями. OTP можна надіслати просто 5 цифрами, коли бот його очікує.'
  });
}

async function showStatus(ctx) {
  await ctx.dashboard.setStatus('Статус оновлено', {
    action: 'Оновлено статус',
    message: formatStatus(ctx.sessionRepository, ctx.scheduler)
  });
}

async function showDoctor(ctx) {
  await ctx.dashboard.setStatus('Doctor оновлено', {
    action: 'Doctor',
    message: formatDoctor(ctx)
  });
}

async function showNextRun(ctx) {
  const state = ctx.sessionRepository.getState();
  const lastRun = ctx.rewardsRepository.getLast();
  const message = [
    `Наступний збір: ${formatDateTime(state.nextRunAt)}`,
    `Останній verified: ${formatDateTime(state.lastSuccessfulCollectAt)}`,
    `Останній run: ${lastRun ? `${formatDateTime(lastRun.createdAt)} ${lastRun.status} ${lastRun.collectedCount}/${lastRun.expectedCount}` : 'немає'}`
  ].join('\n');
  await ctx.dashboard.setStatus('Next run', {
    action: 'Next run',
    message
  });
}

async function sendLatestSnapshot(ctx) {
  const snapshot = await latestDebugSnapshot();
  if (!snapshot) {
    await ctx.dashboard.setStatus('Snapshot не знайдено', {
      action: 'Snapshot',
      message: `У ${config.storage.debugSnapshotsDir} ще немає debug snapshot`
    });
    return;
  }

  await sendDocumentToChat(ctx.bot, config.telegram.chatId, snapshot.path, `Latest debug snapshot\n${snapshot.path}`);
  await ctx.dashboard.setStatus('Snapshot надіслано', {
    action: 'Snapshot',
    message: `${snapshot.path} (${Math.round(snapshot.size / 1024)} KB)`
  });
}

async function showLogs(ctx, lines = 30) {
  const logs = await readPm2Logs(lines);
  await sendMessageToChat(ctx.bot, config.telegram.chatId, codeBlock(logs));
  await ctx.dashboard.setStatus('Logs надіслано', {
    action: 'Logs',
    message: 'Останні PM2 logs надіслано окремим повідомленням'
  });
}

async function verifyShop(ctx) {
  await withActionLock(ctx, 'Verify shop', async () => {
    try {
      await ctx.authFlow.gotoShop();
      const page = ctx.authFlow.getPage();
      const loginVisible = await page.locator(selectors.loginButton).first().isVisible({ timeout: 5000 }).catch(() => false);
      const rewards = loginVisible
        ? []
        : await findAvailableRewards(page, (message, level) => ctx.dashboard.addMessage(level === 'warn' ? `WARN: ${message}` : message));
      if (loginVisible) ctx.sessionRepository.setSessionLost();
      else ctx.sessionRepository.update({ authStatus: 'logged_in' });
      await ctx.authFlow.closeIfIdle();

      const rewardLinesText = rewards.length
        ? rewards.map((reward, index) => `${index + 1}. ${reward.name}`).join('\n')
        : 'Немає доступних Free Gift rewards';
      const message = [
        `Session: ${loginVisible ? 'login required' : 'active'}`,
        `Available rewards: ${rewards.length}`,
        rewardLinesText,
        `Checked: ${formatDateTime(new Date())}`
      ].join('\n');
      await ctx.dashboard.setStatus('Shop перевірено', {
        action: 'Verify shop',
        message
      });
    } catch (error) {
      await ctx.authFlow.closeIfIdle();
      await ctx.dashboard.setStatus('Verify shop failed', {
        action: 'Verify shop failed',
        message: error.message
      });
    }
  });
}

async function showHistory(ctx) {
  await ctx.dashboard.showHistory(ctx.rewardsRepository.getRecent(10));
}

async function showRecentCollects(ctx) {
  const runs = ctx.rewardsRepository.getRecentSuccessful(3);
  await ctx.dashboard.showRecentCollects(runs);
}

async function startLogin(ctx) {
  await withActionLock(ctx, 'Авторизація', async () => {
    const result = await ctx.authFlow.startLogin();
    if (result.status === 'already_logged_in') {
      await ctx.dashboard.setStatus('Сесія активна', {
        action: 'Перевірено авторизацію',
        message: 'Повторний вхід не потрібен'
      });
      return;
    }
    await ctx.dashboard.setStatus('Очікую OTP-код', {
      action: 'Очікую OTP-код',
      message: 'Надішли 5 цифр окремим повідомленням'
    });
  });
}

async function submitOtp(ctx, otp) {
  await withActionLock(ctx, 'OTP', async () => {
    const result = await ctx.authFlow.submitOtp(otp);
    if (result.success) {
      await ctx.dashboard.setStatus('Вхід успішний', {
        action: 'OTP підтверджено',
        message: 'Сесія збережена в browser profile'
      });
      return;
    }
    await ctx.dashboard.setStatus('OTP не спрацював', {
      action: 'OTP не спрацював',
      message: 'Надішли новий 5-значний код'
    });
  });
}

async function checkSession(ctx) {
  await withActionLock(ctx, 'Перевірка сесії', async () => {
    try {
      const loggedIn = await ctx.authFlow.isLoggedIn();
      await ctx.authFlow.closeIfIdle();
      if (loggedIn) {
        ctx.sessionRepository.update({ authStatus: 'logged_in' });
        await ctx.dashboard.setStatus('Сесія активна', {
          action: 'Перевірено сесію',
          message: 'Повторний вхід не потрібен'
        });
        return;
      }
      ctx.sessionRepository.setSessionLost();
      await ctx.dashboard.setStatus('Сесія неактивна', {
        action: 'Перевірено сесію',
        message: 'Потрібно виконати логін'
      });
    } catch (error) {
      await ctx.authFlow.closeIfIdle();
      await ctx.dashboard.setStatus('Не вдалося перевірити сесію', {
        action: 'Помилка перевірки сесії',
        message: error.message
      });
    }
  });
}

async function collectNow(ctx) {
  await withActionLock(ctx, 'Ручний збір подарунків', async () => {
    const result = await ctx.scheduler.runManualCollect();
    if (result.status === 'already_running') {
      await ctx.dashboard.setStatus('Збір уже виконується', {
        action: 'Спроба паралельного збору',
        message: 'Зачекай завершення'
      });
      return;
    }

    const message = buildCollectSummary(result, result.nextRunAt);
    if (result.status === 'session_lost') {
      await ctx.dashboard.setStatus('Потрібна повторна авторизація', {
        action: 'Сесія втрачена',
        message
      });
      return;
    }
    if (result.status === 'unavailable') {
      await ctx.dashboard.setStatus('Подарунки зараз недоступні', {
        action: 'Подарунки недоступні',
        message
      });
      return;
    }

    const doneStatus = collectStatusTitle(result);
    await ctx.dashboard.setStatus(doneStatus, {
      action: doneStatus,
      message
    });
  });
}

function registerBotHandlers({ bot, authFlow, scheduler, rewardsRepository, sessionRepository, dashboard }) {
  const ctx = {
    bot,
    authFlow,
    scheduler,
    rewardsRepository,
    sessionRepository,
    dashboard,
    actionRunning: false,
    lastCallbackAt: 0
  };

  bot.on('message', async (msg) => {
    const text = String(msg.text || '').trim();
    if (text.startsWith('/')) return;
    if (!isAdminChat(msg.chat.id)) {
      await deleteUserMessage(bot, msg);
      return;
    }

    const state = sessionRepository.getState();
    await deleteUserMessage(bot, msg);

    if (state.authStatus === 'waiting_otp' && /^\d{5}$/.test(text)) {
      await submitOtp(ctx, text);
      return;
    }

    if (state.authStatus === 'waiting_otp') {
      await dashboard.setStatus('Очікую OTP-код', {
        action: 'Некоректний OTP',
        message: 'OTP має бути рівно 5 цифр'
      });
    }
  });

  bot.onText(/^\/start$/, async (msg) => {
    if (!isAdminChat(msg.chat.id)) {
      await sendMessageToChat(
        bot,
        msg.chat.id,
        `Цей chat id: ${msg.chat.id}\nЗапиши його в .env як TELEGRAM_CHAT_ID=${msg.chat.id}, потім перезапусти програму.`
      );
      return;
    }
    await dashboard.showDashboard('Dashboard відкрито');
  });

  bot.onText(/^\/dashboard_reset$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await dashboard.resetMessage();
  });

  bot.onText(/^\/help$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await showHelp(ctx);
  });

  bot.onText(/^\/recent_collects$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await showRecentCollects(ctx);
  });

  bot.onText(/^\/images$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await showRecentCollects(ctx);
  });

  bot.onText(/^\/status$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await showStatus(ctx);
  });

  bot.onText(/^\/doctor$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await showDoctor(ctx);
  });

  bot.onText(/^\/commands$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await dashboard.showCommands();
  });

  bot.onText(/^\/snapshot$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await sendLatestSnapshot(ctx);
  });

  bot.onText(/^\/logs(?:\s+(\d+))?$/, async (msg, match) => {
    if (!await guardAdmin(bot, msg)) return;
    const lines = Math.min(100, Math.max(10, Number(match[1]) || 30));
    await showLogs(ctx, lines);
  });

  bot.onText(/^\/verify_shop$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await verifyShop(ctx);
  });

  bot.onText(/^\/next$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await showNextRun(ctx);
  });

  bot.onText(/^\/login$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await startLogin(ctx);
  });

  bot.onText(/^\/check_session$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await checkSession(ctx);
  });

  bot.onText(/^\/otp(?:\s+(.+))?$/, async (msg, match) => {
    if (!await guardAdmin(bot, msg)) return;
    const otp = String(match[1] || '').trim();
    if (!/^\d{5}$/.test(otp)) {
      await dashboard.setStatus('Очікую OTP-код', {
        action: 'Некоректний OTP',
        message: 'OTP має бути рівно 5 цифр'
      });
      return;
    }
    await submitOtp(ctx, otp);
  });

  bot.onText(/^\/collect$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await collectNow(ctx);
  });

  bot.onText(/^\/history$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await showHistory(ctx);
  });

  bot.onText(/^\/last$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await dashboard.setStatus('Останній результат', {
      action: 'Останній результат',
      message: formatRun(rewardsRepository.getLast())
    });
  });

  bot.on('callback_query', async (query) => {
    if (!await guardAdmin(bot, query)) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    const now = Date.now();
    logButtonPress(query);
    if (now - ctx.lastCallbackAt < CALLBACK_COOLDOWN_MS) {
      await bot.answerCallbackQuery(query.id, { text: 'Зачекай секунду...' }).catch(() => {});
      return;
    }
    ctx.lastCallbackAt = now;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    if (query.data === 'dashboard') await dashboard.showDashboard('Повернувся до dashboard');
    else if (query.data === 'commands') await dashboard.showCommands();
    else if (query.data === 'cmd_doctor') await showDoctor(ctx);
    else if (query.data === 'cmd_verify_shop') await verifyShop(ctx);
    else if (query.data === 'cmd_logs') await showLogs(ctx, 50);
    else if (query.data === 'cmd_snapshot') await sendLatestSnapshot(ctx);
    else if (query.data === 'cmd_next') await showNextRun(ctx);
    else if (query.data === 'cmd_images') await showRecentCollects(ctx);
    else if (query.data === 'login') await startLogin(ctx);
    else if (query.data === 'check_session') await checkSession(ctx);
    else if (query.data === 'collect') await collectNow(ctx);
    else if (query.data === 'status') await showStatus(ctx);
    else if (query.data === 'history') await showHistory(ctx);
    else if (query.data === 'recent_collects') await showRecentCollects(ctx);
    else if (query.data === 'help') await showHelp(ctx);
  });
}

module.exports = {
  registerBotHandlers
};
