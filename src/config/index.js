require('dotenv').config();

module.exports = {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    dbPath: process.env.DATABASE_URL || './database.sqlite',
    dashboardPort: process.env.DASHBOARD_PORT || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    headerImagePath: require('path').join(process.cwd(), 'dashboard_header.png')
};
