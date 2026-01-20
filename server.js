const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const path = require('path');
const { initDb } = require('./database');
require('dotenv').config();

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'dashboard')));

// --- API ROUTES ---

// Get overall stats
app.get('/api/stats', async (req, res) => {
    try {
        const db = await initDb();
        const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
        const activeUsers = await db.get('SELECT COUNT(*) as count FROM users WHERE status = "ACTIVE"');
        const premiumUsers = await db.get('SELECT COUNT(*) as count FROM users WHERE is_premium = 1');
        const totalCollections = await db.get('SELECT COUNT(*) as count FROM collection_logs WHERE status = "SUCCESS" OR status = "FAILED"');
        const successCount = await db.get('SELECT COUNT(*) as count FROM collection_logs WHERE status = "SUCCESS"');

        // Success rate for last 7 days
        const recentLogs = await db.all(`
            SELECT 
                DATE(timestamp) as date,
                SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) as success,
                SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed
            FROM collection_logs 
            WHERE timestamp > DATETIME('now', '-7 days')
            GROUP BY DATE(timestamp)
            ORDER BY date ASC
        `);

        res.json({
            metrics: {
                totalUsers: totalUsers.count,
                activeUsers: activeUsers.count,
                premiumUsers: premiumUsers.count,
                totalCollections: successCount.count
            },
            history: recentLogs
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Get user list
app.get('/api/users', async (req, res) => {
    try {
        const db = await initDb();
        const users = await db.all('SELECT * FROM users ORDER BY created_at DESC');
        res.json(users);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Update user status (Block/Premium)
app.post('/api/users/:id/status', async (req, res) => {
    const { id } = req.params;
    const { is_blocked, is_premium } = req.body;
    try {
        const db = await initDb();
        if (is_blocked !== undefined) {
            await db.run('UPDATE users SET is_blocked = ? WHERE telegram_id = ?', [is_blocked ? 1 : 0, id]);
        }
        if (is_premium !== undefined) {
            await db.run('UPDATE users SET is_premium = ? WHERE telegram_id = ?', [is_premium ? 1 : 0, id]);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Broadcast message
app.post('/api/broadcast', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    try {
        const db = await initDb();
        await db.run('INSERT INTO admin_commands (command, payload) VALUES (?, ?)', ['BROADCAST', message]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Manual session check (No auto-notify)
app.post('/api/users/:id/check-session', async (req, res) => {
    const { id } = req.params;
    try {
        const db = await initDb();
        await db.run('INSERT INTO admin_commands (command, payload) VALUES (?, ?)', ['CHECK_SESSION', id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Notify user about expired session
app.post('/api/users/:id/notify-expired', async (req, res) => {
    const { id } = req.params;
    try {
        const db = await initDb();
        await db.run('INSERT INTO admin_commands (command, payload) VALUES (?, ?)', ['NOTIFY_EXPIRED', id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Trigger immediate reward collection
app.post('/api/users/:id/trigger-collect', async (req, res) => {
    const { id } = req.params;
    try {
        const db = await initDb();
        await db.run('INSERT INTO admin_commands (command, payload) VALUES (?, ?)', ['TRIGGER_COLLECT', id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get message history for a user
app.get('/api/users/:id/history', async (req, res) => {
    const { id } = req.params;
    try {
        const db = await initDb();
        const history = await db.all('SELECT * FROM bot_messages WHERE telegram_id = ? ORDER BY timestamp DESC LIMIT 50', [id]);
        res.json(history);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Clear message history for a user
app.post('/api/users/:id/clear-history', async (req, res) => {
    const { id } = req.params;
    try {
        const db = await initDb();
        await db.run('INSERT INTO admin_commands (command, payload) VALUES (?, ?)', ['CLEAR_HISTORY', id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get recent logs
app.get('/api/logs', async (req, res) => {
    try {
        const db = await initDb();
        const logs = await db.all(`
            SELECT l.*, u.email 
            FROM collection_logs l 
            LEFT JOIN users u ON l.user_id = u.telegram_id 
            ORDER BY l.timestamp DESC 
            LIMIT 50
        `);
        res.json(logs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

function startServer() {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 Dashboard Server: Running at http://localhost:${PORT}`);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = { startServer, app };
