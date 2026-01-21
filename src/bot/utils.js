const { initDb } = require('../database');
const logger = require('../utils/logger');

async function trackMsg(telegramId, msgId, text = null, type = 'REACTION', ttlSeconds = null) {
    if (!msgId || !telegramId) return;
    try {
        const db = await initDb();
        let deleteAt = null;
        if (ttlSeconds) {
            deleteAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
        }
        await db.run('INSERT OR REPLACE INTO bot_messages (telegram_id, message_id, text, delete_at, msg_type) VALUES (?, ?, ?, ?, ?)',
            [telegramId, msgId, text, deleteAt, type]);
    } catch (e) {
        logger.error("Track error", e.message);
    }
}

async function logActivity(userId, action, details = null) {
    try {
        const db = await initDb();
        await db.run('INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)',
            [userId, action, details]);

        // Візуальний логер
        if (action.includes('УСПІХ')) logger.success(`${userId}: ${action}`, details);
        else if (action.includes('ПОМИЛКА') || action.includes('ВТРАЧЕНА')) logger.warn(`${userId}: ${action}`, details);
        else logger.info(`${userId}: ${action}`, details);

    } catch (e) { }
}

async function cleanupHistory(ctx, exceptDashboard = true) {
    if (!ctx.from) return;
    try {
        const db = await initDb();
        const messages = await db.all('SELECT message_id FROM bot_messages WHERE telegram_id = ? ORDER BY timestamp DESC', [ctx.from.id]);

        for (const msg of messages) {
            if (exceptDashboard && ctx.session?.dashboardId === msg.message_id) continue;
            await ctx.deleteMessage(msg.message_id).catch(() => { });
        }

        if (exceptDashboard && ctx.session?.dashboardId) {
            await db.run('DELETE FROM bot_messages WHERE telegram_id = ? AND message_id != ?', [ctx.from.id, ctx.session.dashboardId]);
        } else {
            await db.run('DELETE FROM bot_messages WHERE telegram_id = ?', [ctx.from.id]);
        }
    } catch (e) { }
}

async function cleanupReactions(ctxOrTelegram, telegramId = null) {
    let tId = telegramId;
    let telegram = ctxOrTelegram;

    if (ctxOrTelegram.from) {
        tId = ctxOrTelegram.from.id;
        telegram = ctxOrTelegram.telegram;
    }

    if (!tId) return;

    try {
        const db = await initDb();
        const messages = await db.all('SELECT message_id FROM bot_messages WHERE telegram_id = ? AND msg_type = "REACTION"', [tId]);

        for (const msg of messages) {
            await telegram.deleteMessage(tId, msg.message_id).catch(() => { });
        }
        await db.run('DELETE FROM bot_messages WHERE telegram_id = ? AND msg_type = "REACTION"', [tId]);
    } catch (e) { }
}

async function startTTLWorker(bot) {
    setInterval(async () => {
        try {
            const db = await initDb();
            const now = new Date().toISOString();
            const expired = await db.all('SELECT * FROM bot_messages WHERE delete_at IS NOT NULL AND delete_at < ?', [now]);

            for (const msg of expired) {
                await bot.telegram.deleteMessage(msg.telegram_id, msg.message_id).catch(() => { });
                await db.run('DELETE FROM bot_messages WHERE id = ?', [msg.id]);
            }
        } catch (e) { }
    }, 10000); // Кожні 10 секунд
}

module.exports = { trackMsg, cleanupHistory, cleanupReactions, logActivity, startTTLWorker };
