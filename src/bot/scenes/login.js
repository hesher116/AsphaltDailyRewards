const { Scenes } = require('telegraf');
const AsphaltAutomation = require('../../services/automation');
const { initDb } = require('../../database');
const { trackMsg } = require('../utils');
const { showDashboard } = require('../dashboard');
const fs = require('fs');

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const loginScene = new Scenes.WizardScene(
    'LOGIN_SCENE',
    // Step 1: Ask Email
    async (ctx) => {
        await cleanupReactions(ctx);
        const m1 = await ctx.reply('📧 Введіть Ваш **Email** Gameloft Club:');
        await trackMsg(ctx.from.id, m1.message_id, '🤖: Введіть Ваш Email', 'REACTION');
        return ctx.wizard.next();
    },
    // Step 2: Handle Email & Start Login
    async (ctx) => {
        if (!ctx.message) return;
        const text = ctx.message.text?.trim() || '';
        if (text === '/start' || text === '/cancel') return ctx.scene.leave();

        if (!emailRegex.test(text)) {
            await cleanupReactions(ctx);
            const m = await ctx.reply('❌ Некоректна пошта. Спробуйте ще раз:');
            await trackMsg(ctx.from.id, m.message_id, '🤖: Некоректна пошта', 'REACTION');
            return;
        }

        ctx.wizard.state.email = text;
        await cleanupReactions(ctx);
        const mWait = await ctx.reply(`🚀 Ініціалізація ${text}...`);
        await trackMsg(ctx.from.id, mWait.message_id, `🤖: Ініціалізація ${text}`, 'REACTION');

        const automation = new AsphaltAutomation(text, ctx.from.id);
        try {
            await automation.init(false);
            const result = await automation.startLogin();
            await cleanupReactions(ctx);

            if (result === "NEED_OTP") {
                ctx.wizard.state.automation = automation;
                const mOtp = await ctx.reply('📨 Код відправлено! Введіть **OTP код**:');
                await trackMsg(ctx.from.id, mOtp.message_id, '🤖: Введіть OTP код', 'REACTION');
                return ctx.wizard.next();
            } else {
                const mErr = await ctx.reply(`❌ Помилка: ${result}`);
                await trackMsg(ctx.from.id, mErr.message_id, `🤖: Помилка: ${result}`, 'REACTION');
                await automation.close();
                return ctx.scene.leave();
            }
        } catch (e) {
            await automation.close().catch(() => { });
            return ctx.scene.leave();
        }
    },
    // Step 3: Handle OTP
    async (ctx) => {
        if (!ctx.message) return;
        const text = ctx.message.text?.trim() || '';
        const automation = ctx.wizard.state.automation;

        const success = await automation.submitOtp(text);
        await cleanupReactions(ctx);

        if (success) {
            const { count, rewardImages } = await automation.collectRewards();
            await automation.close();

            const db = await initDb();
            // Оновлюємо основну пошту та статус
            await db.run('UPDATE users SET email = ?, status = "ACTIVE" WHERE telegram_id = ?',
                [ctx.wizard.state.email, ctx.from.id]);

            // Додаємо в список пошт (для преміума)
            await db.run('INSERT OR IGNORE INTO user_emails (user_id, email, status) VALUES (?, ?, ?)',
                [ctx.from.id, ctx.wizard.state.email, 'ACTIVE']);

            const mRes = await ctx.reply(`✅ Вхід успішний! Зібрано ${count} нагород.`);
            await trackMsg(ctx.from.id, mRes.message_id, `🤖: Вхід успішний (${count})`, 'REACTION');

            if (count > 0) {
                await db.run('INSERT INTO collection_logs (user_id, status, rewards_collected) VALUES (?, ?, ?)',
                    [ctx.from.id, 'SUCCESS', count]);

                if (rewardImages && rewardImages.length > 0) {
                    for (const imgUrl of rewardImages) {
                        const p = await ctx.telegram.sendPhoto(ctx.from.id, imgUrl).catch(() => null);
                        if (p) await trackMsg(ctx.from.id, p.message_id, "🖼️ Reward Image", "REACTION");
                    }
                }
            }
        } else {
            await automation.close();
            const mF = await ctx.reply('❌ Помилка входу.');
            await trackMsg(ctx.from.id, mF.message_id, '🤖: Помилка входу', 'REACTION');
        }

        await showDashboard(ctx);
        return ctx.scene.leave();
    }
);

module.exports = loginScene;
