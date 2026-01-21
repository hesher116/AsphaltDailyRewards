const { initDb } = require('../database');
const { runCollectionForUser, activeTasks } = require('../bot/handlers');
const AsphaltAutomation = require('../services/automation');
const { trackMsg } = require('../bot/utils');
const { showDashboardToUser } = require('../bot/dashboard');
const fs = require('fs');

async function handleBroadcast(bot, cmd) {
    const db = await initDb();
    const message = cmd.payload;
    const ttl = cmd.ttl_seconds;

    let users = [];
    if (cmd.target_id) {
        users = [{ telegram_id: cmd.target_id }];
    } else if (cmd.target_group === 'premium') {
        users = await db.all('SELECT telegram_id FROM users WHERE is_premium = 1 AND status = "ACTIVE"');
    } else if (cmd.target_group === 'blocked') {
        users = await db.all('SELECT telegram_id FROM users WHERE is_blocked = 1');
    } else {
        users = await db.all('SELECT telegram_id FROM users');
    }

    logger.cmd(`BROADCAST`, `Targeting ${users.length} users (Group: ${cmd.target_group || 'custom'})`);

    for (const user of users) {
        try {
            const sent = await bot.telegram.sendMessage(user.telegram_id, `📣 **Сповіщення:**\n\n${message}`, {
                parse_mode: 'Markdown'
            });
            await trackMsg(user.telegram_id, sent.message_id, `🤖 [Broadcast]: ${message}`, ttl || null);
        } catch (e) {
            console.error(`Broadcast error to ${user.telegram_id}:`, e.message);
        }
    }
}

async function handleCheckSession(bot, telegramId) {
    const db = await initDb();
    const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
    if (!user) return;

    activeTasks.add(telegramId);
    const automation = new AsphaltAutomation(user.email, telegramId);
    try {
        await automation.init(false); // Все одно в хедлес: фалсе для дебагу
        await automation.page.goto('https://shop.gameloft.com/games/Asphalt_Legends', { waitUntil: 'networkidle' });
        await automation.page.waitForTimeout(4000);
        const loginBtn = automation.page.locator('button:has-text("Log in")').first();
        const isLogged = await loginBtn.isHidden();
        await automation.close();

        const status = isLogged ? 'ACTIVE' : 'EXPIRED';
        await db.run('UPDATE users SET last_check_status = ?, last_check_at = CURRENT_TIMESTAMP WHERE telegram_id = ?', [status, telegramId]);
        if (!isLogged) await db.run('UPDATE users SET status = "NEED_AUTH" WHERE telegram_id = ?', [telegramId]);
    } catch (e) {
        console.error("Check session error:", e);
    } finally {
        activeTasks.delete(telegramId);
    }
}

async function handleClearHistory(bot, telegramId) {
    const db = await initDb();
    const messages = await db.all('SELECT message_id FROM bot_messages WHERE telegram_id = ?', [telegramId]);
    for (const msg of messages) {
        await bot.telegram.deleteMessage(telegramId, msg.message_id).catch(() => { });
    }
    await db.run('DELETE FROM bot_messages WHERE telegram_id = ?', [telegramId]);

    // Перекидаємо на головний дашборд
    await showDashboardToUser(bot.telegram, telegramId);
}

function startAdminPoller(bot) {
    setInterval(async () => {
        try {
            const db = await initDb();
            const commands = await db.all('SELECT * FROM admin_commands WHERE status = "PENDING" ORDER BY created_at ASC');

            for (const cmd of commands) {
                await db.run('UPDATE admin_commands SET status = "PROCESSING" WHERE id = ?', [cmd.id]);
                try {
                    switch (cmd.command) {
                        case 'BROADCAST':
                            await handleBroadcast(bot, cmd);
                            break;
                        case 'NOTIFY':
                            const { telegramId, text: notifyText } = JSON.parse(cmd.payload);
                            const sentNotify = await bot.telegram.sendMessage(telegramId, notifyText, { parse_mode: 'Markdown' });
                            await trackMsg(telegramId, sentNotify.message_id, `🤖: ${notifyText}`);
                            break;
                        case 'CHECK_SESSION':
                            await handleCheckSession(bot, parseInt(cmd.payload));
                            break;
                        case 'CLEAR_HISTORY':
                            await handleClearHistory(bot, parseInt(cmd.payload));
                            break;
                        case 'TRIGGER_COLLECT':
                            const u = await db.get('SELECT email FROM users WHERE telegram_id = ?', [cmd.payload]);
                            if (u) runCollectionForUser(bot, parseInt(cmd.payload), u.email);
                            break;
                        case 'PAUSE_SYSTEM':
                            await db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES ("is_paused", "1")');
                            logger.warn("🛑 SYSTEM PAUSED");
                            break;
                        case 'RESUME_SYSTEM':
                            await db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES ("is_paused", "0")');
                            logger.success("▶️ SYSTEM RESUMED");
                            break;
                    }
                    await db.run('UPDATE admin_commands SET status = "COMPLETED" WHERE id = ?', [cmd.id]);
                } catch (e) {
                    console.error("Command error:", e);
                    await db.run('UPDATE admin_commands SET status = "FAILED" WHERE id = ?', [cmd.id]);
                }
            }
        } catch (e) { }
    }, 3000);
}

module.exports = { startAdminPoller };
