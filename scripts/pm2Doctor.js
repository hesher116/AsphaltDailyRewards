const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_NAME = 'asphalt-daily-rewards';
const PM2_HOME = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    return [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim();
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function existsText(filePath) {
  return fs.existsSync(filePath) ? 'yes' : 'no';
}

function listProcesses() {
  const output = run('pm2', ['jlist']);
  try {
    return JSON.parse(output || '[]');
  } catch {
    return [];
  }
}

function recentLogLine(filePath) {
  if (!fs.existsSync(filePath)) return 'missing';
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return 'empty';
  const lines = content.split(/\r?\n/);
  return lines[lines.length - 1];
}

function envValue(processInfo, key) {
  if (!processInfo) return '(missing)';
  if (processInfo.pm2_env && processInfo.pm2_env.env && processInfo.pm2_env.env[key]) {
    return processInfo.pm2_env.env[key];
  }
  if (processInfo.pm2_env && processInfo.pm2_env[key]) return processInfo.pm2_env[key];
  if (processInfo.env && processInfo.env[key]) return processInfo.env[key];
  if (processInfo[key]) return processInfo[key];
  return '(not set)';
}

function main() {
  const dumpPath = path.join(PM2_HOME, 'dump.pm2');
  const outLog = path.join(PM2_HOME, 'logs', `${APP_NAME}-out-0.log`);
  const errorLog = path.join(PM2_HOME, 'logs', `${APP_NAME}-error-0.log`);
  const dump = readJson(dumpPath, []);
  const processes = listProcesses();
  const current = processes.find((item) => item.name === APP_NAME);
  const saved = dump.find((item) => item.name === APP_NAME);

  process.stdout.write([
    `PM2_HOME: ${PM2_HOME}`,
    `Current process: ${current ? current.pm2_env.status : 'missing'}`,
    `Saved dump entry: ${saved ? 'yes' : 'no'}`,
    `Dump file: ${existsText(dumpPath)} (${dumpPath})`,
    `Out log: ${existsText(outLog)} (${outLog})`,
    `Error log: ${existsText(errorLog)} (${errorLog})`,
    `Current HEADLESS: ${envValue(current, 'HEADLESS')}`,
    `Current BROWSER_ENGINE: ${envValue(current, 'BROWSER_ENGINE')}`,
    `Saved HEADLESS: ${envValue(saved, 'HEADLESS')}`,
    `Saved BROWSER_ENGINE: ${envValue(saved, 'BROWSER_ENGINE')}`,
    '',
    `Last out log: ${recentLogLine(outLog)}`,
    `Last error log: ${recentLogLine(errorLog)}`,
    '',
    'If Current process is missing but Saved dump entry is yes, run: npm run pm2:recover'
  ].join('\n'));
  process.stdout.write('\n');
}

main();
