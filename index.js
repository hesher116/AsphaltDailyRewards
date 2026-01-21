const { initDb } = require('./src/database');
const { initBot } = require('./src/bot');
const { startServer } = require('./src/api');
const { startAdminPoller } = require('./src/api/admin_poller');

async function main() {
    try {
        console.log('🚀 Starting Asphalt Rewards System (Modular)...');

        // 1. Database
        await initDb();

        // 2. Bot
        const bot = await initBot();

        // 3. API & Admin Poller
        await startServer();
        startAdminPoller(bot);

        console.log('✨ System fully operational.');
    } catch (e) {
        console.error('💥 Critical Startup Error:', e);
        process.exit(1);
    }
}

main();
