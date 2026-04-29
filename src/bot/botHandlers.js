const config = require('../config');
const { formatDateTime } = require('../utils/time');
const { sendMessageToChat } = require('./telegramBot');

const CALLBACK_COOLDOWN_MS = 1200;

function isAdminChat(chatId) {
  return Boolean(config.telegram.chatId) && String(chatId) === String(config.telegram.chatId);
}

async function deleteUserMessage(bot, msg) {
  await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
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

function collectionSummary(result, nextRunAt) {
  const rewardText = rewardLines(result.rewards).replace(/\n/g, '; ');
  const prefix = result.status === 'success'
    ? 'Щоденні нагороди зібрано успішно.'
    : result.status === 'partial'
      ? 'Зібрано частину щоденних нагород.'
      : result.status === 'session_lost'
        ? 'Потрібна повторна авторизація.'
        : 'Щоденні нагороди зараз недоступні.';
  const preserved = result.schedulePreserved ? ' Графік не змінено: це була невдала ручна спроба.' : '';
  return `${prefix} Отримано: ${rewardText}. Наступний збір: ${formatDateTime(nextRunAt)}.${preserved}`;
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

async function showHistory(ctx) {
  await ctx.dashboard.showHistory(ctx.rewardsRepository.getRecent(10));
}

async function showRecentCollects(ctx) {
  await ctx.dashboard.showRecentCollects(ctx.rewardsRepository.getRecentSuccessful(3));
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

    const message = collectionSummary(result, result.nextRunAt);
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

    await ctx.dashboard.setStatus('Збір завершено', {
      action: 'Збір завершено',
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

  bot.onText(/^\/status$/, async (msg) => {
    if (!await guardAdmin(bot, msg)) return;
    await showStatus(ctx);
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
    if (now - ctx.lastCallbackAt < CALLBACK_COOLDOWN_MS) {
      await bot.answerCallbackQuery(query.id, { text: 'Зачекай секунду...' }).catch(() => {});
      return;
    }
    ctx.lastCallbackAt = now;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    if (query.data === 'dashboard') await dashboard.showDashboard('Повернувся до dashboard');
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
