const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    blue: "\x1b[34m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    cyan: "\x1b[36m"
};

const logger = {
    info: (msg, details = "") => {
        const time = new Date().toLocaleTimeString();
        console.log(`${colors.dim}[${time}]${colors.reset} ${colors.blue}${colors.bright}[INFO]${colors.reset} ${msg} ${colors.dim}${details}${colors.reset}`);
    },
    success: (msg, details = "") => {
        const time = new Date().toLocaleTimeString();
        console.log(`${colors.dim}[${time}]${colors.reset} ${colors.green}${colors.bright}[SUCCESS]${colors.reset} ${msg} ${colors.dim}${details}${colors.reset}`);
    },
    warn: (msg, details = "") => {
        const time = new Date().toLocaleTimeString();
        console.log(`${colors.dim}[${time}]${colors.reset} ${colors.yellow}${colors.bright}[WARN]${colors.reset} ${msg} ${colors.dim}${details}${colors.reset}`);
    },
    error: (msg, details = "") => {
        const time = new Date().toLocaleTimeString();
        console.log(`${colors.dim}[${time}]${colors.reset} ${colors.red}${colors.bright}[CRITICAL]${colors.reset} ${colors.red}${msg}${colors.reset} ${details}`);
    },
    cmd: (cmd, payload = "") => {
        const time = new Date().toLocaleTimeString();
        console.log(`${colors.dim}[${time}]${colors.reset} ${colors.cyan}${colors.bright}[CMD]${colors.reset} ${colors.cyan}${cmd}${colors.reset} ${payload}`);
    }
};

module.exports = logger;
