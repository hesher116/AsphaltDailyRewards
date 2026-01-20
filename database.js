const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

async function initDb() {
    const db = await open({
        filename: process.env.DATABASE_URL || './database.sqlite',
        driver: sqlite3.Database
    });

    // Таблиця користувачів
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY,
            email TEXT NOT NULL,
            status TEXT DEFAULT 'NEED_AUTH',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Мigrate existing users table if needed
    const columns = await db.all("PRAGMA table_info(users)");
    const columnNames = columns.map(c => c.name);

    if (!columnNames.includes('is_blocked')) {
        await db.exec('ALTER TABLE users ADD COLUMN is_blocked INTEGER DEFAULT 0');
    }
    if (!columnNames.includes('is_premium')) {
        await db.exec('ALTER TABLE users ADD COLUMN is_premium INTEGER DEFAULT 0');
    }
    if (!columnNames.includes('last_activity')) {
        await db.exec('ALTER TABLE users ADD COLUMN last_activity DATETIME');
        await db.exec('UPDATE users SET last_activity = CURRENT_TIMESTAMP WHERE last_activity IS NULL');
    }
    if (!columnNames.includes('last_check_status')) {
        await db.exec('ALTER TABLE users ADD COLUMN last_check_status TEXT');
    }
    if (!columnNames.includes('last_check_at')) {
        await db.exec('ALTER TABLE users ADD COLUMN last_check_at DATETIME');
    }

    // Таблиця команд для міжпроцесного спілкування
    await db.exec(`
        CREATE TABLE IF NOT EXISTS admin_commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            command TEXT NOT NULL,
            payload TEXT,
            status TEXT DEFAULT 'PENDING',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Таблиця сесій (куки Playwright)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            user_id INTEGER PRIMARY KEY,
            browser_state TEXT,
            last_used DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(telegram_id)
        )
    `);

    // Таблиця логів збору
    await db.exec(`
        CREATE TABLE IF NOT EXISTS collection_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            status TEXT,
            rewards_collected INTEGER DEFAULT 0,
            error_message TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            next_run_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(telegram_id)
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS bot_messages (
            telegram_id INTEGER,
            message_id INTEGER,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    return db;
}

module.exports = { initDb };
