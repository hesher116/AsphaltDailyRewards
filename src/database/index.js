const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const config = require('../config');

let db = null;

async function initDb() {
    if (db) return db;

    db = await open({
        filename: config.dbPath,
        driver: sqlite3.Database
    });

    // 1. Створюємо базові таблиці
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY,
            email TEXT,
            status TEXT DEFAULT 'NEED_AUTH',
            is_premium INTEGER DEFAULT 0,
            is_blocked INTEGER DEFAULT 0,
            last_check_status TEXT,
            last_check_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS collection_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT,
            rewards_collected INTEGER,
            FOREIGN KEY(user_id) REFERENCES users(telegram_id)
        );

        CREATE TABLE IF NOT EXISTS bot_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id INTEGER,
            message_id INTEGER,
            text TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(telegram_id, message_id)
        );

        CREATE TABLE IF NOT EXISTS admin_commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            command TEXT,
            payload TEXT,
            status TEXT DEFAULT 'PENDING',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS user_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT,
            details TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS user_emails (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            email TEXT,
            status TEXT DEFAULT 'NEED_AUTH',
            last_collect_at DATETIME,
            FOREIGN KEY(user_id) REFERENCES users(telegram_id),
            UNIQUE(user_id, email)
        );

        CREATE TABLE IF NOT EXISTS system_config (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // --- ОДНОРАЗОВА ОЧИСТКА ---
    // Ми вже очистили логи при першому запуску, надалі це не потрібно.
    // await db.run('DELETE FROM collection_logs'); 

    // 2. ВРУЧНУ ДОДАЄМО КОЛОНКИ, ЯКИХ МОЖЕ НЕ БУТИ (Міграції)
    const addColumn = async (table, col, type) => {
        try {
            await db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
            console.log(`✅ Added ${col} to ${table}`);
        } catch (e) {
            if (!e.message.includes('duplicate column name')) {
                console.error(`Migration error (${table}.${col}):`, e.message);
            }
        }
    };

    await addColumn('bot_messages', 'delete_at', 'DATETIME');
    await addColumn('bot_messages', 'text', 'TEXT');
    await addColumn('bot_messages', 'msg_type', 'TEXT');
    await addColumn('users', 'trial_expires_at', 'DATETIME');
    await addColumn('admin_commands', 'target_id', 'INTEGER');
    await addColumn('admin_commands', 'target_group', 'TEXT');
    await addColumn('admin_commands', 'ttl_seconds', 'INTEGER');

    return db;
}

module.exports = { initDb };
