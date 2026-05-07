const { execFileSync } = require('child_process');

const APP_NAME = 'asphalt-daily-rewards';

function run(command, args, { allowFailure = false } = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    if (allowFailure) return output;
    throw new Error(output || error.message);
  }
}

function listProcesses() {
  const output = run('pm2', ['jlist'], { allowFailure: true });
  try {
    return JSON.parse(output || '[]');
  } catch {
    return [];
  }
}

function appProcess() {
  return listProcesses().find((processInfo) => processInfo.name === APP_NAME);
}

function printStatus() {
  const output = run('pm2', ['status', APP_NAME], { allowFailure: true });
  if (output) process.stdout.write(`${output}\n`);
}

function recover() {
  const current = appProcess();
  if (current && current.pm2_env && current.pm2_env.status === 'online') {
    process.stdout.write(`${APP_NAME} is already online.\n`);
    printStatus();
    return;
  }

  if (current) {
    process.stdout.write(`${APP_NAME} exists but is ${current.pm2_env.status}, restarting...\n`);
    run('pm2', ['restart', APP_NAME], { allowFailure: true });
    const restarted = appProcess();
    if (restarted && restarted.pm2_env && restarted.pm2_env.status === 'online') {
      run('pm2', ['save'], { allowFailure: true });
      printStatus();
      return;
    }
  }

  process.stdout.write(`Recovering ${APP_NAME} with pm2 resurrect...\n`);
  run('pm2', ['resurrect'], { allowFailure: true });

  const restored = appProcess();
  if (restored && restored.pm2_env && restored.pm2_env.status === 'online') {
    process.stdout.write(`${APP_NAME} restored from PM2 dump.\n`);
    printStatus();
    return;
  }

  if (restored) {
    process.stdout.write(`${APP_NAME} was restored but is ${restored.pm2_env.status}, restarting...\n`);
    run('pm2', ['restart', APP_NAME], { allowFailure: true });
    const restarted = appProcess();
    if (restarted && restarted.pm2_env && restarted.pm2_env.status === 'online') {
      run('pm2', ['save'], { allowFailure: true });
      printStatus();
      return;
    }
  }

  process.stdout.write(`${APP_NAME} was not restored, starting from ecosystem.config.js...\n`);
  run('pm2', ['start', 'ecosystem.config.js']);
  run('pm2', ['save'], { allowFailure: true });
  printStatus();
}

recover();
