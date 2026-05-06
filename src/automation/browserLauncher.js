const { chromium, firefox } = require('playwright');
const config = require('../config');

const engines = {
  chromium,
  firefox
};

function getBrowserEngine() {
  const engine = config.browser.engine;
  if (!engines[engine]) {
    throw new Error(`Unsupported BROWSER_ENGINE="${engine}". Use chromium or firefox.`);
  }
  return engines[engine];
}

function createLaunchOptions() {
  const options = {
    headless: config.browser.headless,
    viewport: config.browser.viewport,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  if (config.browser.engine === 'chromium') {
    options.args = [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      ...config.browser.extraArgs
    ];
  } else if (config.browser.extraArgs.length) {
    options.args = config.browser.extraArgs;
  }

  if (config.browser.executablePath) {
    options.executablePath = config.browser.executablePath;
  }

  return options;
}

async function launchPersistentBrowserContext(profileDir) {
  return getBrowserEngine().launchPersistentContext(profileDir, createLaunchOptions());
}

module.exports = {
  launchPersistentBrowserContext,
  createLaunchOptions
};
