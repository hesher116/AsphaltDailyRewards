const { initDb } = require('../database');
const AsphaltAutomation = require('../services/automation');
const config = require('../config');
const { trackMsg, cleanupHistory, cleanupReactions, logActivity } = require('./utils');
const { showDashboard } = require('./dashboard');
const fs = require('fs');
const path = require('path');
const { Markup } = require('telegraf');
const logger = require('../utils/logger');

const activeTasks = new Set();
const lastActions = new Map();

function checkCooldown(userId, action, seconds = 60) {
    const userCooldowns = lastActions.get(userId) || {};
    const lastTime = userCooldowns[action] || 0;
    const now = Date.now();
    if (now - lastTime < seconds * 1000) return Math.ceil((seconds * 1000 - (now - lastTime)) / 1000);
    userCooldowns[action] = now;
    lastActions.set(userId, userCooldowns);
    return 0;
}

async function trackGlobalRewardImages(rewardImages) {
    if (!rewardImages || rewardImages.length < 2) return;
    const db = await initDb();
    const current1 = await db.get('SELECT value FROM system_config WHERE key = "reward_img_1"');
    const current2 = await db.get('SELECT value FROM system_config WHERE key = "reward_img_2"');

    if (rewardImages[0] !== current1?.value || rewardImages[1] !== current2?.value) {
        await db.run('INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ("reward_img_1", ?, CURRENT_TIMESTAMP)', [rewardImages[0]]);
        await db.run('INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ("reward_img_2", ?, CURRENT_TIMESTAMP)', [rewardImages[1]]);
        logger.success("♻️ Global reward images updated!");
    }
}

async function runCollectionForUser(bot, telegramId, emailHint = null) {
    const db = await initDb();
    const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
    if (!user || user.is_blocked) return;

    // Списки імейлів для збору
    let emailsToProcess = [];
    if (user.is_premium) {
        const premiumEmails = await db.all('SELECT email FROM user_emails WHERE user_id = ?', [telegramId]);
        emailsToProcess = premiumEmails.map(e => e.email);
        if (emailsToProcess.length === 0 && user.email) emailsToProcess = [user.email];
    } else {
        emailsToProcess = [user.email || emailHint];
    }

    emailsToProcess = emailsToProcess.filter(e => !!e);
    if (emailsToProcess.length === 0) return;

    for (const email of emailsToProcess) {
        const automation = new AsphaltAutomation(email, telegramId);
        try {
            await logActivity(telegramId, 'ЗБІР_СТАРТ', `Email: ${email}`);
            await automation.init(false);
            const result = await automation.collectRewards();

            await cleanupReactions(bot.telegram, telegramId);

            if (result === "SESSION_LOST") {
                const msg = await bot.telegram.sendMessage(telegramId, `⚠️ **Сесія застаріла (${email})!** Будь ласка, увійдіть знову.`);
                await trackMsg(telegramId, msg.message_id, `⚠️ SESSION_LOST: ${email}`);
                await logActivity(telegramId, 'СЕСІЯ_ВТРАЧЕНА', email);
                await automation.close();
                continue;
            }

            const { count, rewardImages } = result;
            await automation.close();

            if (count > 0) {
                await db.run('UPDATE users SET last_check_at = CURRENT_TIMESTAMP WHERE telegram_id = ?', [telegramId]);
                await db.run('INSERT INTO collection_logs (user_id, status, rewards_collected) VALUES (?, ?, ?)',
                    [telegramId, 'SUCCESS', count]);

                const msg = await bot.telegram.sendMessage(telegramId, `✅ **${email}**: Зібрано ${count} нагород!`, { parse_mode: 'Markdown' }).catch(() => { });
                if (msg) await trackMsg(telegramId, msg.message_id, `✅ SUCCESS: ${email} (${count})`);

                if (rewardImages && rewardImages.length > 0) {
                    await trackGlobalRewardImages(rewardImages);
                    for (const imgUrl of rewardImages) {
                        const p = await bot.telegram.sendPhoto(telegramId, imgUrl).catch(() => { });
                        if (p) await trackMsg(telegramId, p.message_id, `🖼️ Reward Image`, 'REACTION');
                    }
                }
                await logActivity(telegramId, 'ЗБІР_УСПІХ', `${email} -> ${count}`);
            } else {
                const msg = await bot.telegram.sendMessage(telegramId, `ℹ️ **${email}**: Вільних нагород немає.`, { parse_mode: 'Markdown' }).catch(() => { });
                if (msg) await trackMsg(telegramId, msg.message_id, `ℹ️ EMPTY: ${email}`);
                await logActivity(telegramId, 'ЗБІР_ПУСТО', email);
            }
        } catch (e) {
            logger.error(`[${telegramId}] Помилка збору (${email})`, e.message);
            await logActivity(telegramId, 'ЗБІР_ПОМИЛКА', `${email}: ${e.message}`);
        }
    }
}

function registerHandlers(bot) {
    // Middleware для захисту від спаму та блокування
    bot.on('message', async (ctx, next) => {
        const db = await initDb();
        const user = await db.get('SELECT is_blocked FROM users WHERE telegram_id = ?', [ctx.from.id]);

        // Якщо користувач заблокований - видаляємо БУДЬ-ЯКЕ його повідомлення
        if (user?.is_blocked) {
            return ctx.deleteMessage().catch(() => { });
        }

        const isCmd = ctx.message.text?.startsWith('/');
        const isWizard = !!ctx.scene?.current;

        if (!isCmd && !isWizard) {
            return ctx.deleteMessage().catch(() => { });
        }
        return next();
    });

    bot.command('start', async (ctx) => {
        const db = await initDb();
        const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [ctx.from.id]);

        if (!user) {
            const expires = new Date();
            expires.setDate(expires.getDate() + 3);
            await db.run('INSERT INTO users (telegram_id, trial_expires_at) VALUES (?, ?)',
                [ctx.from.id, expires.toISOString()]);
        }

        await logActivity(ctx.from.id, 'КОМАНДА_СТАРТ');
        await cleanupHistory(ctx, false);
        ctx.session = {};
        await showDashboard(ctx);
    });

    bot.action('action_start', async (ctx) => {
        ctx.answerCbQuery();
        await logActivity(ctx.from.id, 'КЛІК_СТАРТ');
        await cleanupHistory(ctx, false);
        ctx.session = {};
        await showDashboard(ctx);
    });

    bot.action('action_info', async (ctx) => {
        ctx.answerCbQuery();
        await logActivity(ctx.from.id, 'КЛІК_ІНФО');
        const text = `ℹ️ **Про бот Asphalt Rewards**\n\n` +
            `Цей бот автоматизує збір щоденних нагород у Gameloft Club.\n\n` +
            `🔹 **Trial:** 3 дні безкоштовно (тільки ручний збір).\n` +
            `🔸 **Premium:** Авто-збір кожні 24г, підтримка до 3-х пошт одночасно.\n\n` +
            `👨‍💻 Розробник: @hesher116\n\n` +
            `💳 [Оплатити Premium](https://hesher116.github.io/pay)`; // Заглушка

        await cleanupReactions(ctx);
        const msg = await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Назад', 'action_start')]
        ]));
        await trackMsg(ctx.from.id, msg.message_id, `ℹ️ INFO`, 'REACTION');
    });

    bot.action('action_rewards', async (ctx) => {
        const db = await initDb();
        const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [ctx.from.id]);
        const stats = await db.get('SELECT SUM(rewards_collected) as total FROM collection_logs WHERE user_id = ? AND status = "SUCCESS"', [ctx.from.id]);
        const img1 = await db.get('SELECT value FROM system_config WHERE key = "reward_img_1"');
        const img2 = await db.get('SELECT value FROM system_config WHERE key = "reward_img_2"');

        ctx.answerCbQuery();
        await logActivity(ctx.from.id, 'КЛІК_НАГОРОДИ');

        const text = `🎁 **Ваші нагороди**\n\n` +
            `🔹 Всього зібрано: **${stats?.total || 0}**\n` +
            `🔹 Тип аккаунту: ${user.is_premium ? '⭐ Premium' : '🆓 Trial'}\n\n` +
            `👇 **Актуальні подарунки у грі зараз:**`;

        await cleanupReactions(ctx);
        const msg = await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Назад', 'action_start')]
        ]));
        await trackMsg(ctx.from.id, msg.message_id, `🎁 REWARDS`, 'REACTION');

        if (img1?.value) await ctx.replyWithPhoto(img1.value).then(m => trackMsg(ctx.from.id, m.message_id, "🖼️ Reward 1", "REACTION")).catch(() => { });
        if (img2?.value) await ctx.replyWithPhoto(img2.value).then(m => trackMsg(ctx.from.id, m.message_id, "🖼️ Reward 2", "REACTION")).catch(() => { });
    });

    bot.action('action_auth', async (ctx) => {
        const db = await initDb();
        const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [ctx.from.id]);

        if (user?.is_blocked) return ctx.answerCbQuery('🚫 Доступ заблоковано.', { show_alert: true });

        const emails = await db.all('SELECT email FROM user_emails WHERE user_id = ?', [ctx.from.id]);
        if (!user.is_premium && user.status === 'ACTIVE') {
            return ctx.answerCbQuery('🔒 Тріал-версія дозволяє тільки 1 аккаунт.', { show_alert: true });
        }
        if (user.is_premium && emails.length >= 3) {
            return ctx.answerCbQuery('🔒 Максимум 3 аккаунти для Premium.', { show_alert: true });
        }

        if (activeTasks.has(ctx.from.id)) return ctx.answerCbQuery('⚠️ Зачекайте...');
        ctx.answerCbQuery();
        await logActivity(ctx.from.id, 'КЛІК_АВТОРІЗАЦІЯ');
        ctx.scene.enter('LOGIN_SCENE');
    });

    bot.action('action_logout', async (ctx) => {
        const db = await initDb();
        const user = await db.get('SELECT status FROM users WHERE telegram_id = ?', [ctx.from.id]);
        if (!user || user.status !== 'ACTIVE') return ctx.answerCbQuery('🔒 Ви не в системі.', { show_alert: true });

        ctx.answerCbQuery('🚪 Вихід...');
        await logActivity(ctx.from.id, 'КЛІК_ВИХІД');
        activeTasks.add(ctx.from.id);

        await db.run('UPDATE users SET status = "NEED_AUTH" WHERE telegram_id = ?', [ctx.from.id]);
        await db.run('DELETE FROM user_emails WHERE user_id = ?', [ctx.from.id]);

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
        if (user.is_blocked) return ctx.answerCbQuery('🚫 Доступ заблоковано.', { show_alert: true });

        const cd = checkCooldown(ctx.from.id, 'check', 60);
        if (cd > 0) return ctx.answerCbQuery(`⏳ ${cd}с.`, { show_alert: true });

        ctx.answerCbQuery('🛡️ Перевірка...');
        await logActivity(ctx.from.id, 'КЛІК_ПЕРЕВІРКА');
        activeTasks.add(ctx.from.id);

        const automation = new AsphaltAutomation(user.email, ctx.from.id);
        try {
            await automation.init(false);
            await automation.page.goto('https://shop.gameloft.com/games/Asphalt_Legends', { waitUntil: 'networkidle' });
            await automation.page.waitForTimeout(4000);
            const loginBtn = automation.page.locator('button:has-text("Log in")').first();
            const isLogged = await loginBtn.isHidden();
            await automation.close();

            await cleanupReactions(ctx);
            const msg = isLogged ? '✅ Сесія активна!' : '❌ Сесія застаріла.';
            if (!isLogged) await db.run('UPDATE users SET status = "NEED_AUTH" WHERE telegram_id = ?', [ctx.from.id]);
            await showDashboard(ctx, msg);
        } catch (e) {
            await showDashboard(ctx, "❌ Помилка перевірки.");
        } finally {
            activeTasks.delete(ctx.from.id);
        }
    });

    bot.action('action_collect', async (ctx) => {
        const db = await initDb();
        const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [ctx.from.id]);
        if (!user || user.status !== 'ACTIVE') return ctx.answerCbQuery('🔒 Треба вхід.', { show_alert: true });
        if (user.is_blocked) return ctx.answerCbQuery('🚫 Доступ заблоковано.', { show_alert: true });

        if (!user.is_premium) {
            const exp = new Date(user.trial_expires_at);
            if (new Date() > exp) return ctx.answerCbQuery('❌ Тріал закінчився! Купіть Premium.', { show_alert: true });
        }

        const cd = checkCooldown(ctx.from.id, 'collect', 300);
        if (cd > 0) return ctx.answerCbQuery(`⏳ ${Math.floor(cd / 60)}хв.`, { show_alert: true });

        ctx.answerCbQuery('🚀 Починаю...');
        await logActivity(ctx.from.id, 'КЛІК_ЗБІР');
        activeTasks.add(ctx.from.id);
        runCollectionForUser(ctx, ctx.from.id, user.email).finally(() => {
            activeTasks.delete(ctx.from.id);
            showDashboard(ctx);
        });
    });
}

async function startScheduler(bot) {
    setInterval(async () => {
        try {
            const db = await initDb();
            const pauseFlag = await db.get('SELECT value FROM system_config WHERE key = "is_paused"');
            if (pauseFlag?.value === '1') return;

            const now = Date.now();
            const users = await db.all('SELECT * FROM users WHERE status = "ACTIVE" AND is_premium = 1 AND is_blocked = 0');
            for (const user of users) {
                if (activeTasks.has(user.telegram_id)) continue;
                const lastLog = await db.get('SELECT timestamp FROM collection_logs WHERE user_id = ? AND status = "SUCCESS" AND rewards_collected > 0 ORDER BY timestamp DESC LIMIT 1', [user.telegram_id]);
                const lastTime = lastLog ? new Date(lastLog.timestamp).getTime() : 0;
                if (now - lastTime >= (24 * 60 * 60 * 1000)) {
                    activeTasks.add(user.telegram_id);
                    runCollectionForUser(bot, user.telegram_id).finally(() => activeTasks.delete(user.telegram_id));
                }
            }
        } catch (e) { }
    }, 60 * 1000);
}

module.exports = { registerHandlers, startScheduler, runCollectionForUser, activeTasks };
