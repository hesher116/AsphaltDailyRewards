const { startServer } = require('./server');
const args = process.argv.slice(2);

const startAll = args.length === 0;
const startBot = startAll || args.includes('--bot');
const startDash = startAll || args.includes('--dashboard');

if (startBot) {
    console.log('🚀 Starting Telegram Bot...');
    require('./bot');
}

if (startDash) {
    console.log('🌐 Starting Admin Dashboard...');
    startServer();
}

if (!startBot && !startDash) {
    console.log('Usage:');
    console.log('  node index.js              (Start both)');
    console.log('  node index.js --bot        (Start only bot)');
    console.log('  node index.js --dashboard  (Start only dashboard)');
}
