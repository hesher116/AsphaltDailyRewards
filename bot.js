const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { initDb } = require('./database');
const AsphaltAutomation = require('./automation');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

process.on('unhandledRejection', (reason, promise) => {
    console.error('Bot Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Bot Uncaught Exception:', err);
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const activeTasks = new Set();
const lastActions = new Map();
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEADER_PATH = path.join(process.cwd(), 'dashboard_header.png');

// --- ДОПОМІЖНІ ФУНКЦІЇ ---

async function trackMsg(ctx, msgId) {
    if (!msgId || !ctx.from) return;
    try {
        const db = await initDb();
        await db.run('INSERT INTO bot_messages (telegram_id, message_id) VALUES (?, ?)', [ctx.from.id, msgId]);
    } catch (e) { }
}

async function cleanupHistory(ctx, exceptDashboard = true) {
    if (!ctx.from) return;
    try {
        const db = await initDb();
        const messages = await db.all('SELECT message_id FROM bot_messages WHERE telegram_id = ?', [ctx.from.id]);

        console.log(`🧹 Cleanup: ${messages.length} messages for ${ctx.from.id}`);
        for (const msg of messages) {
            // Не видаляємо повідомлення, якщо це поточний дашборд (фото)
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

function checkCooldown(userId, action, seconds = 60) {
    const userCooldowns = lastActions.get(userId) || {};
    const lastTime = userCooldowns[action] || 0;
    const now = Date.now();

    if (now - lastTime < seconds * 1000) {
        return Math.ceil((seconds * 1000 - (now - lastTime)) / 1000);
    }

    userCooldowns[action] = now;
    lastActions.set(userId, userCooldowns);
    return 0;
}

async function showDashboard(ctx, overrideText = null) {
    const db = await initDb();
    const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [ctx.from.id]);
    const lastLog = await db.get('SELECT * FROM collection_logs WHERE user_id = ? AND status = "SUCCESS" AND rewards_collected > 0 ORDER BY timestamp DESC LIMIT 1', [ctx.from.id]);

    const isAuthorized = user && user.status === 'ACTIVE';
    let status = isAuthorized ? 'Активний ✅' : 'Потрібна авторизація ⚠️';
    let lastCollection = "—";

    if (lastLog) {
        const date = new Date(lastLog.timestamp).toLocaleString('uk-UA');
        lastCollection = `${date} (${lastLog.rewards_collected}/2)`;
    }

    const dashboardText = overrideText || `🏎️ **Asphalt Daily Rewards Dashboard**\n\n` +
        `👤 **Статус:** ${status}\n` +
        `📧 **Email:** ${user ? user.email : '—'}\n` +
        `🎁 **Останній збір:** ${lastCollection}\n\n` +
        `Оберіть дію:`;

    const loginBtn = isAuthorized ? '🔒 Увійти (Вже вході)' : '🔑 Увійти';
    const logoutBtn = !isAuthorized ? '🔒 Вийти (Треба вхід)' : '🚪 Вийти';

    const buttons = [
        [
            Markup.button.callback(loginBtn, 'action_auth'),
            Markup.button.callback(logoutBtn, 'action_logout')
        ],
        [Markup.button.callback('🛡️ Перевірити сесію', 'action_check')],
        [Markup.button.callback('🎁 Зібрати подарунки', 'action_collect')],
        [Markup.button.callback('🏠 Головне меню', 'action_start')]
    ];

    try {
        if (ctx.session?.dashboardId) {
            // Намагаємось оновити Caption під фото
            await ctx.telegram.editMessageCaption(ctx.from.id, ctx.session.dashboardId, null, dashboardText, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            }).catch(async () => {
                // Якщо не вдалося (наприклад, пройшло багато часу), перевідправляємо
                await cleanupHistory(ctx, false);
                const msg = await ctx.replyWithPhoto({ source: HEADER_PATH }, {
                    caption: dashboardText,
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard(buttons)
                });
                await trackMsg(ctx, msg.message_id);
                ctx.session.dashboardId = msg.message_id;
            });
        } else {
            await cleanupHistory(ctx, false);
            const msg = await ctx.replyWithPhoto({ source: HEADER_PATH }, {
                caption: dashboardText,
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            });
            await trackMsg(ctx, msg.message_id);
            ctx.session.dashboardId = msg.message_id;
        }
    } catch (e) {
        // Fallback якщо немає фото
        const msg = await ctx.replyWithMarkdown(dashboardText, Markup.inlineKeyboard(buttons));
        await trackMsg(ctx, msg.message_id);
        ctx.session.dashboardId = msg.message_id;
    }
}

// --- СЦЕНИ ---

const loginScene = new Scenes.WizardScene(
    'LOGIN_SCENE',
    async (ctx) => {
        const m1 = await ctx.reply('📧 Введіть Ваш **Email** Gameloft Club:');
        await trackMsg(ctx, m1.message_id);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message) return;
        const text = ctx.message.text?.trim() || '';
        if (text === '/start' || text === '/cancel') return ctx.scene.leave();

        if (!emailRegex.test(text)) {
            const m = await ctx.reply('❌ Некоректна пошта. Спробуйте ще раз:');
            await trackMsg(ctx, m.message_id);
            return;
        }

        ctx.wizard.state.email = text;
        activeTasks.add(ctx.from.id);
        const mWait = await ctx.reply(`🚀 Ініціалізація ${text}...`);
        await trackMsg(ctx, mWait.message_id);

        const automation = new AsphaltAutomation(text, ctx.from.id);
        try {
            await automation.init(false);
            const result = await automation.startLogin();
            if (result === "NEED_OTP") {
                ctx.wizard.state.automation = automation;
                const mOtp = await ctx.reply('📨 Код відправлено! Введіть **OTP код**:');
                await trackMsg(ctx, mOtp.message_id);
                return ctx.wizard.next();
            } else {
                const mErr = await ctx.reply(`❌ Помилка: ${result}`);
                await trackMsg(ctx, mErr.message_id);
                await automation.close();
                activeTasks.delete(ctx.from.id);
                return ctx.scene.leave();
            }
        } catch (e) {
            await automation.close().catch(() => { });
            activeTasks.delete(ctx.from.id);
            return ctx.scene.leave();
        }
    },
    async (ctx) => {
        if (!ctx.message) return;
        const text = ctx.message.text?.trim() || '';
        const automation = ctx.wizard.state.automation;

        const success = await automation.submitOtp(text);
        if (success) {
            const { count, screenshots } = await automation.collectRewards();
            await automation.close();

            const db = await initDb();
            await db.run('INSERT OR REPLACE INTO users (telegram_id, email, status) VALUES (?, ?, ?)',
                [ctx.from.id, ctx.wizard.state.email, 'ACTIVE']);

            if (count > 0) {
                await db.run('INSERT INTO collection_logs (user_id, status, rewards_collected) VALUES (?, ?, ?)',
                    [ctx.from.id, 'SUCCESS', count]);
            }

            const mRes = await ctx.reply(`✅ Вхід успішний! Зібрано ${count} нагород.`);
            await trackMsg(ctx, mRes.message_id);
            for (const s of screenshots) {
                const p = await bot.telegram.sendPhoto(ctx.from.id, { source: s }).catch(() => null);
                if (p) await trackMsg(ctx, p.message_id);
                if (fs.existsSync(s)) fs.unlinkSync(s);
            }
        } else {
            await automation.close();
            const mF = await ctx.reply('❌ Помилка входу.');
            await trackMsg(ctx, mF.message_id);
        }

        activeTasks.delete(ctx.from.id);
        await showDashboard(ctx);
        return ctx.scene.leave();
    }
);

const stage = new Scenes.Stage([loginScene]);
bot.use(session());

bot.use(async (ctx, next) => {
    if (ctx.message) {
        await trackMsg(ctx, ctx.message.message_id);
    }
    return next();
});

bot.use(stage.middleware());

// --- ОБРОБНИКИ ---

bot.command('start', async (ctx) => {
    await cleanupHistory(ctx, false);
    ctx.session = {}; // Скидаємо сесію для нового дашборду
    await showDashboard(ctx);
});

bot.action('action_start', async (ctx) => {
    ctx.answerCbQuery();
    await cleanupHistory(ctx, false);
    ctx.session = {};
    await showDashboard(ctx);
});

bot.action('action_auth', async (ctx) => {
    const db = await initDb();
    const user = await db.get('SELECT status FROM users WHERE telegram_id = ?', [ctx.from.id]);
    if (user?.status === 'ACTIVE') {
        return ctx.answerCbQuery('🔒 Ви вже авторизовані!', { show_alert: true });
    }
    if (activeTasks.has(ctx.from.id)) return ctx.answerCbQuery('⚠️ Зачекайте...');
    ctx.answerCbQuery();
    ctx.scene.enter('LOGIN_SCENE');
});

bot.action('action_logout', async (ctx) => {
    const db = await initDb();
    const user = await db.get('SELECT status FROM users WHERE telegram_id = ?', [ctx.from.id]);
    if (!user || user.status !== 'ACTIVE') return ctx.answerCbQuery('🔒 Ви не в системі.', { show_alert: true });

    ctx.answerCbQuery('🚪 Вихід...');
    activeTasks.add(ctx.from.id);
    await db.run('UPDATE users SET status = "NEED_AUTH" WHERE telegram_id = ?', [ctx.from.id]);

    const profileDir = path.join(process.cwd(), 'browser_profiles', String(ctx.from.id));
    if (fs.existsSync(profileDir)) {
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { }
    }
    activeTasks.delete(ctx.from.id);
    await showDashboard(ctx, "✅ Ви вийшли з системи.");
});

bot.action('action_check', async (ctx) => {
    const db = await initDb();
    const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [ctx.from.id]);
    if (!user || user.status !== 'ACTIVE') return ctx.answerCbQuery('🔒 Треба вхід.', { show_alert: true });

    const cd = checkCooldown(ctx.from.id, 'check', 60);
    if (cd > 0) return ctx.answerCbQuery(`⏳ ${cd}с.`, { show_alert: true });

    ctx.answerCbQuery('🛡️ Перевірка...');
    activeTasks.add(ctx.from.id);

    const automation = new AsphaltAutomation(user.email, ctx.from.id);
    try {
        await automation.init(process.env.NODE_ENV === 'production');
        await automation.page.goto('https://shop.gameloft.com/games/Asphalt_Legends', { waitUntil: 'networkidle' });
        await automation.page.waitForTimeout(4000);
        const loginBtn = automation.page.locator('button:has-text("Log in")').first();
        const isLogged = await loginBtn.isHidden();
        await automation.close();

        const msg = isLogged ? '✅ Сесія активна!' : '❌ Сесія втрачена.';
        if (!isLogged) await db.run('UPDATE users SET status = "NEED_AUTH" WHERE telegram_id = ?', [ctx.from.id]);
        await showDashboard(ctx, msg);
    } finally {
        activeTasks.delete(ctx.from.id);
    }
});

bot.action('action_collect', async (ctx) => {
    const db = await initDb();
    const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [ctx.from.id]);
    if (!user || user.status !== 'ACTIVE') return ctx.answerCbQuery('🔒 Треба вхід.', { show_alert: true });

    const cd = checkCooldown(ctx.from.id, 'collect', 300);
    if (cd > 0) return ctx.answerCbQuery(`⏳ Зачекайте ${Math.floor(cd / 60)}хв.`, { show_alert: true });

    ctx.answerCbQuery('🚀 Починаю...');
    activeTasks.add(ctx.from.id);
    runCollectionForUser(ctx.from.id, user.email).finally(() => {
        activeTasks.delete(ctx.from.id);
        showDashboard(ctx);
    });
});

async function runCollectionForUser(telegramId, email) {
    const automation = new AsphaltAutomation(email, telegramId);
    try {
        await automation.init(process.env.NODE_ENV === 'production');
        const result = await automation.collectRewards();

        if (result === "SESSION_LOST") {
            const db = await initDb();
            await db.run('UPDATE users SET status = "NEED_AUTH" WHERE telegram_id = ?', [telegramId]);
            const m = await bot.telegram.sendMessage(telegramId, `⚠️ **Сесія застаріла!**`);
            await trackManualMsg(telegramId, m.message_id);
            await automation.close();
            return;
        }

        const { count, screenshots } = result;
        await automation.close();

        const db = await initDb();
        if (count > 0) {
            await db.run('INSERT INTO collection_logs (user_id, status, rewards_collected) VALUES (?, ?, ?)',
                [telegramId, 'SUCCESS', count]);
            const m = await bot.telegram.sendMessage(telegramId, `✅ Зібрано ${count} нагород!`);
            await trackManualMsg(telegramId, m.message_id);
            for (const s of screenshots) {
                const p = await bot.telegram.sendPhoto(telegramId, { source: s }).catch(() => null);
                if (p) await trackManualMsg(telegramId, p.message_id);
                if (fs.existsSync(s)) fs.unlinkSync(s);
            }
        } else {
            const m = await bot.telegram.sendMessage(telegramId, `ℹ️ Вільних нагород немає.`);
            await trackManualMsg(telegramId, m.message_id);
        }
    } catch (e) {
        const m = await bot.telegram.sendMessage(telegramId, `❌ Технічна помилка.`);
        await trackManualMsg(telegramId, m.message_id);
    }
}

async function trackManualMsg(telegramId, msgId) {
    try {
        const db = await initDb();
        await db.run('INSERT INTO bot_messages (telegram_id, message_id) VALUES (?, ?)', [telegramId, msgId]);
    } catch (e) { }
}

async function startScheduler() {
    setInterval(async () => {
        try {
            const db = await initDb();
            const now = Date.now();
            const users = await db.all('SELECT * FROM users WHERE status = "ACTIVE"');
            for (const user of users) {
                if (activeTasks.has(user.telegram_id)) continue;
                const lastLog = await db.get('SELECT timestamp FROM collection_logs WHERE user_id = ? AND status = "SUCCESS" AND rewards_collected > 0 ORDER BY timestamp DESC LIMIT 1', [user.telegram_id]);
                const lastTime = lastLog ? new Date(lastLog.timestamp).getTime() : 0;
                if (now - lastTime >= (24 * 60 * 60 * 1000)) {
                    activeTasks.add(user.telegram_id);
                    runCollectionForUser(user.telegram_id, user.email).finally(() => activeTasks.delete(user.telegram_id));
                }
            }
        } catch (e) { }
    }, 60 * 1000);
}

// --- ADMIN COMMAND POLLER ---

async function pollAdminCommands() {
    setInterval(async () => {
        try {
            const db = await initDb();
            const commands = await db.all('SELECT * FROM admin_commands WHERE status = "PENDING" ORDER BY created_at ASC');

            for (const cmd of commands) {
                await db.run('UPDATE admin_commands SET status = "PROCESSING" WHERE id = ?', [cmd.id]);

                try {
                    switch (cmd.command) {
                        case 'BROADCAST':
                            await handleBroadcast(cmd.payload);
                            break;
                        case 'CHECK_SESSION':
                            await handleCheckSession(cmd.payload);
                            break;
                        case 'NOTIFY_EXPIRED':
                            await handleNotifyExpired(cmd.payload);
                            break;
                        case 'CLEAR_HISTORY':
                            await handleClearHistory(cmd.payload);
                            break;
                        case 'TRIGGER_COLLECT':
                            await handleTriggerCollect(cmd.payload);
                            break;
                    }
                    await db.run('UPDATE admin_commands SET status = "COMPLETED" WHERE id = ?', [cmd.id]);
                } catch (e) {
                    await db.run('UPDATE admin_commands SET status = "FAILED" WHERE id = ?', [cmd.id]);
                }
            }
        } catch (e) { }
    }, 3000);
}

async function handleBroadcast(message) {
    const db = await initDb();
    const users = await db.all('SELECT telegram_id FROM users WHERE status = "ACTIVE"');
    for (const user of users) {
        try {
            const m = await bot.telegram.sendMessage(user.telegram_id, `📣 **Сповіщення від адміністратора:**\n\n${message}`, { parse_mode: 'Markdown' });
            await trackManualMsg(user.telegram_id, m.message_id);
        } catch (e) { }
    }
}

async function handleCheckSession(telegramId) {
    const db = await initDb();
    const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
    if (!user) return;

    activeTasks.add(telegramId);
    const automation = new AsphaltAutomation(user.email, telegramId);
    try {
        await automation.init(true);
        await automation.page.goto('https://shop.gameloft.com/games/Asphalt_Legends', { waitUntil: 'networkidle' });
        await automation.page.waitForTimeout(4000);
        const loginBtn = automation.page.locator('button:has-text("Log in")').first();
        const isLogged = await loginBtn.isHidden();
        await automation.close();

        // Оновлюємо статус в БД БЕЗ автоматичного сповіщення
        const status = isLogged ? 'ACTIVE' : 'EXPIRED';
        await db.run('UPDATE users SET last_check_status = ?, last_check_at = CURRENT_TIMESTAMP WHERE telegram_id = ?', [status, telegramId]);

        if (!isLogged) {
            await db.run('UPDATE users SET status = "NEED_AUTH" WHERE telegram_id = ?', [telegramId]);
        }
    } catch (e) {
    } finally {
        activeTasks.delete(telegramId);
    }
}

async function handleNotifyExpired(telegramId) {
    try {
        const m = await bot.telegram.sendMessage(telegramId, `⚠️ **Ваша сесія застаріла!**\nБудь ласка, перезайдіть у гру через бота, щоб продовжити отримувати нагороди.`);
        await trackManualMsg(telegramId, m.message_id);
    } catch (e) { }
}

async function handleClearHistory(telegramId) {
    const db = await initDb();
    const messages = await db.all('SELECT message_id FROM bot_messages WHERE telegram_id = ?', [telegramId]);
    for (const msg of messages) {
        await bot.telegram.deleteMessage(telegramId, msg.message_id).catch(() => { });
    }
    await db.run('DELETE FROM bot_messages WHERE telegram_id = ?', [telegramId]);
}

async function handleTriggerCollect(telegramId) {
    const db = await initDb();
    const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
    if (!user) return;

    // Перевикористовуємо існуючу функцію збору
    // Але нам потрібно впевнитись, що runCollectionForUser експортується або доступна
    runCollectionForUser(telegramId, user.email).catch(() => { });
}

async function main() {
    await initDb();
    bot.launch();
    console.log('🤖 Asphalt Bot: Header Image & Aggressive Cleanup Active');
    startScheduler();
    pollAdminCommands();
}

main().catch(console.error);
