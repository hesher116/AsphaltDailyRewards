const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const path = require('path');
const { initDb } = require('../database');
const config = require('../config');
const logger = require('../utils/logger');

const app = express();

app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));
app.use(bodyParser.json());
app.use(express.static(path.join(process.cwd(), 'dashboard')));

// --- API ROUTES ---

app.get('/api/stats', async (req, res) => {
    try {
        const db = await initDb();
        const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
        const activeUsers = await db.get('SELECT COUNT(*) as count FROM users WHERE status = "ACTIVE"');
        const premiumUsers = await db.get('SELECT COUNT(*) as count FROM users WHERE is_premium = 1');
        const blockedUsers = await db.get('SELECT COUNT(*) as count FROM users WHERE is_blocked = 1');
        const pauseFlag = await db.get('SELECT value FROM system_config WHERE key = "is_paused"');

        // ВАЖЛИВО: SUM замість COUNT для реальної кількості подарунків
        const rewardsResult = await db.get('SELECT SUM(rewards_collected) as total FROM collection_logs WHERE status = "SUCCESS"');

        const history = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];

            const stats = await db.get(`
                SELECT 
                    SUM(CASE WHEN status = 'SUCCESS' THEN rewards_collected ELSE 0 END) as success,
                    SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed
                FROM collection_logs 
                WHERE DATE(timestamp) = ?
            `, [dateStr]);

            history.push({
                date: dateStr,
                success: stats.success || 0,
                failed: stats.failed || 0
            });
        }

        res.json({
            metrics: {
                totalUsers: totalUsers.count,
                activeUsers: activeUsers.count,
                premiumUsers: premiumUsers.count,
                blockedUsers: blockedUsers.count,
                totalCollections: rewardsResult.total || 0,
                is_paused: pauseFlag?.value || '0'
            },
            history: history
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', async (req, res) => {
    try {
        const db = await initDb();
        const users = await db.all(`
            SELECT u.*, 
                   MAX(cl.timestamp) as last_collect_at 
            FROM users u
            LEFT JOIN collection_logs cl ON u.telegram_id = cl.user_id AND cl.status = 'SUCCESS'
            GROUP BY u.telegram_id
            ORDER BY u.created_at DESC
        `);
        res.json(users);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:id/activity', async (req, res) => {
    try {
        const db = await initDb();
        // Об'єднуємо активність та повідомлення для повної історії (як в чаті)
        const activity = await db.all(`
            SELECT 'ACTION' as type, action as title, details, timestamp FROM user_activity WHERE user_id = ?
            UNION ALL
            SELECT 'CH' as type, 'CHAT' as title, text as details, timestamp FROM bot_messages WHERE telegram_id = ?
            ORDER BY timestamp DESC LIMIT 100
        `, [req.params.id, req.params.id]);
        res.json(activity);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/logs', async (req, res) => {
    try {
        const db = await initDb();
        const logs = await db.all('SELECT * FROM user_activity ORDER BY timestamp DESC LIMIT 100');
        res.json(logs);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/config/rewards', async (req, res) => {
    try {
        const db = await initDb();
        const img1 = await db.get('SELECT value FROM system_config WHERE key = "reward_img_1"');
        const img2 = await db.get('SELECT value FROM system_config WHERE key = "reward_img_2"');
        res.json({ img1: img1?.value, img2: img2?.value });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:id/chat', async (req, res) => {
    const { id } = req.params;
    try {
        const db = await initDb();
        const chat = await db.all('SELECT * FROM bot_messages WHERE telegram_id = ? ORDER BY timestamp ASC LIMIT 200', [id]);
        res.json(chat);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:id/status', async (req, res) => {
    const { id } = req.params;
    const { is_blocked, is_premium } = req.body;
    try {
        const db = await initDb();
        console.log(`[API] Updating user ${id}: blocked=${is_blocked}, premium=${is_premium}`);

        if (is_blocked !== undefined) {
            // Якщо блокуємо - знімаємо преміум
            if (is_blocked) await db.run('UPDATE users SET is_premium = 0 WHERE telegram_id = ?', [id]);
            await db.run('UPDATE users SET is_blocked = ? WHERE telegram_id = ?', [is_blocked ? 1 : 0, id]);

            const msg = is_blocked ? "🚫 Ваш аккаунт заблоковано адміністратором." : "✅ Ваш аккаунт розблоковано!";
            await db.run('INSERT INTO admin_commands (command, payload) VALUES (?, ?)',
                ['NOTIFY', JSON.stringify({ telegramId: id, text: msg })]);
        }

        if (is_premium !== undefined) {
            // Якщо даємо преміум - розблоковуємо
            if (is_premium) await db.run('UPDATE users SET is_blocked = 0 WHERE telegram_id = ?', [id]);
            await db.run('UPDATE users SET is_premium = ? WHERE telegram_id = ?', [is_premium ? 1 : 0, id]);

            if (is_premium) {
                const msg = "🌟 **Вітаємо!** Вам активовано **Premium** статус!\n\nТепер доступний авто-збір кожні 24г та підтримка до 3-х аккаунтів.";
                await db.run('INSERT INTO admin_commands (command, payload) VALUES (?, ?)',
                    ['NOTIFY', JSON.stringify({ telegramId: id, text: msg })]);
            }
        }

        res.json({ success: true });
    } catch (e) {
        logger.error(`[API] Error updating user ${id}`, e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/broadcast', async (req, res) => {
    const { message, target_id, target_group, ttl } = req.body;
    try {
        const db = await initDb();
        await db.run('INSERT INTO admin_commands (command, payload, target_id, target_group, ttl_seconds) VALUES (?, ?, ?, ?, ?)',
            ['BROADCAST', message, target_id || null, target_group || 'all', ttl || null]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/system/toggle', async (req, res) => {
    const { command } = req.body;
    try {
        const db = await initDb();
        if (command === 'PAUSE_SYSTEM') {
            await db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES ("is_paused", "1")');
        } else {
            await db.run('INSERT OR REPLACE INTO system_config (key, value) VALUES ("is_paused", "0")');
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:id/check-session', async (req, res) => {
    try {
        const db = await initDb();
        await db.run('INSERT INTO admin_commands (command, payload) VALUES (?, ?)', ['CHECK_SESSION', req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:id/clear-history', async (req, res) => {
    try {
        const db = await initDb();
        await db.run('INSERT INTO admin_commands (command, payload) VALUES (?, ?)', ['CLEAR_HISTORY', req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

function startServer() {
    return new Promise((resolve) => {
        app.listen(config.dashboardPort, '0.0.0.0', () => {
            logger.info(`🌐 Dashboard Server`, `Running at http://localhost:${config.dashboardPort}`);
            resolve(app);
        });
    });
}

module.exports = { startServer, app };
