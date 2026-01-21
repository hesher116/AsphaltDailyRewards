const { Markup } = require('telegraf');
const { initDb } = require('../database');
const { trackMsg, cleanupHistory } = require('./utils');
const config = require('../config');

async function getDashboardInfo(telegramId) {
    const db = await initDb();
    const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
    const emails = await db.all('SELECT email FROM user_emails WHERE user_id = ?', [telegramId]);
    const lastLog = await db.get('SELECT * FROM collection_logs WHERE user_id = ? AND status = "SUCCESS" AND rewards_collected > 0 ORDER BY timestamp DESC LIMIT 1', [telegramId]);

    if (!user) return { isAuthorized: false, text: 'Вітаємо! Натисніть /start.' };

    const isPremium = !!user.is_premium;
    const isBlocked = !!user.is_blocked;

    let tierText = isPremium ? '⭐ PREMIUM' : '🆓 TRIAL (3 дні)';
    if (isBlocked) tierText = '🚫 ЗАБЛОКОВАНО';

    let trialInfo = '';
    if (!isPremium && !isBlocked) {
        if (user.trial_expires_at) {
            const exp = new Date(user.trial_expires_at);
            const now = new Date();
            const diffDays = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
            trialInfo = `⏳ **Тріал закінчується через:** ${diffDays > 0 ? diffDays + ' дн.' : 'сьогодні'}\n`;
        }
    }

    const isAuthorized = user.status === 'ACTIVE' || emails.length > 0;
    const status = isAuthorized ? 'Активний ✅' : 'Потрібна авторизація ⚠️';
    let lastCollection = "—";

    if (lastLog) {
        const date = new Date(lastLog.timestamp).toLocaleString('uk-UA');
        lastCollection = `${date} (${lastLog.rewards_collected}/2)`;
    }

    // Список імейлів для преміума
    let emailText = user.email || '—';
    if (isPremium && emails.length > 1) {
        emailText = emails.map(e => e.email).join(', ');
    }

    return {
        isAuthorized,
        isBlocked,
        text: `🏎️ **Asphalt Daily Rewards Dashboard**\n\n` +
            `💎 **Тариф:** ${tierText}\n` +
            `${trialInfo}` +
            `👤 **Статус:** ${status}\n` +
            `📧 **Email:** ${emailText}\n` +
            `🎁 **Останній збір:** ${lastCollection}\n\n`
    };
}

async function showDashboard(ctx, statusUpdate = null) {
    return showDashboardToUser(ctx.telegram, ctx.from.id, statusUpdate, ctx.session);
}

async function showDashboardToUser(bot, telegramId, statusUpdate = null, session = {}) {
    const info = await getDashboardInfo(telegramId);

    const dashboardText = info.text + (statusUpdate ? `📢 **Статус:** ${statusUpdate}\n\n` : '') + `Оберіть дію:`;

    const loginBtnText = info.isAuthorized ? '🔒 Увійти (Вже в вході)' : '🔑 Увійти';
    const logoutBtnText = !info.isAuthorized ? '🔒 Вийти (Треба вхід)' : '🚪 Вийти';

    let buttons = [];
    if (info.isBlocked) {
        buttons = [
            [Markup.button.callback('🎁 Мої нагороди', 'action_rewards')],
            [Markup.button.callback('ℹ️ Інфо / Premium', 'action_info')],
            [Markup.button.callback('🏠 Головне', 'action_start')]
        ];
    } else {
        buttons = [
            [
                Markup.button.callback(loginBtnText, 'action_auth'),
                Markup.button.callback(logoutBtnText, 'action_logout')
            ],
            [Markup.button.callback('🛡️ Перевірити сесію', 'action_check')],
            [Markup.button.callback('🎁 Зібрати подарунки', 'action_collect')],
            [Markup.button.callback('🎁 Мої нагороди', 'action_rewards')],
            [
                Markup.button.callback('🏠 Головне', 'action_start'),
                Markup.button.callback('ℹ️ Інфо / Premium', 'action_info')
            ]
        ];
    }

    try {
        if (session?.dashboardId) {
            // Редагуємо існуючий дашборд (фото)
            await bot.editMessageCaption(telegramId, session.dashboardId, null, dashboardText, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            }).catch(async () => {
                const msg = await bot.sendPhoto(telegramId, { source: config.headerImagePath }, {
                    caption: dashboardText,
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard(buttons)
                });
                await trackMsg(telegramId, msg.message_id, "Asphalt Dashboard", "DASHBOARD");
                session.dashboardId = msg.message_id;
            });
        } else {
            const msg = await bot.sendPhoto(telegramId, { source: config.headerImagePath }, {
                caption: dashboardText,
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            });
            await trackMsg(telegramId, msg.message_id, "Asphalt Dashboard", "DASHBOARD");
            session.dashboardId = msg.message_id;
        }
    } catch (e) {
        const msg = await bot.sendMessage(telegramId, dashboardText, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        });
        await trackMsg(telegramId, msg.message_id, "Asphalt Dashboard", "DASHBOARD");
        session.dashboardId = msg.message_id;
    }
}

module.exports = { showDashboard, showDashboardToUser };
