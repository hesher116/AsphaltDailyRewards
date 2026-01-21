const { Telegraf, Scenes, session } = require('telegraf');
const config = require('../config');
const loginScene = require('./scenes/login');
const { registerHandlers, startScheduler } = require('./handlers');
const { trackMsg, startTTLWorker } = require('./utils');
const logger = require('../utils/logger');

async function initBot() {
    const bot = new Telegraf(config.telegramToken);
    const stage = new Scenes.Stage([loginScene]);

    bot.use(session());

    // Перехоплення ВІДПОВІДЕЙ бота для видалення
    const originalPost = bot.telegram.callApi.bind(bot.telegram);
    bot.telegram.callApi = async function (method, data) {
        const result = await originalPost(method, data);

        if (result && result.message_id && (data.chat_id || data.user_id)) {
            const chatId = data.chat_id || data.user_id;
            const text = data.text || data.caption || `[Binary/Photo: ${method}]`;

            // Не трекаємо сам дашборд тут як звичайне повідомлення для видалення (якщо це не ручний виклик)
            if (method.startsWith('send')) {
                await trackMsg(chatId, result.message_id, `🤖: ${text}`);
            }
        }
        return result;
    };

    // Middleware для трекінгу вхідних повідомлень
    bot.use(async (ctx, next) => {
        if (ctx.message) {
            const updateType = Object.keys(ctx.update).find(k => k !== 'update_id');
            const text = ctx.message.text || ctx.message.caption || `[Тип: ${updateType}]`;
            await trackMsg(ctx.from.id, ctx.message.message_id, `👤: ${text}`);
        }
        return next();
    });

    bot.use(stage.middleware());

    registerHandlers(bot);
    startScheduler(bot);
    startTTLWorker(bot);

    bot.launch();
    logger.success('🤖 Asphalt Bot', 'Modularized & Ready (with Tracker)');
    return bot;
}

module.exports = { initBot };
