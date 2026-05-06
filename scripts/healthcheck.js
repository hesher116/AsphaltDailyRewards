const { chromium } = require('playwright');
const config = require('../src/config');
const logger = require('../src/utils/logger');
const { ensureDir } = require('../src/utils/fileCleanup');

async function main() {
  logger.info('Перевіряю конфігурацію');

  if (!config.asphalt.shopUrl) {
    throw new Error('SHOP_URL порожній');
  }

  await ensureDir(config.browser.profileDir);

  logger.info(`Запускаю Chromium у режимі HEADLESS=${config.browser.headless}`);
  const context = await chromium.launchPersistentContext(config.browser.profileDir, {
    headless: config.browser.headless,
    viewport: config.browser.viewport,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu'
    ]
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(config.runtime.selectorTimeoutMs);
    page.setDefaultNavigationTimeout(config.runtime.navigationTimeoutMs);

    logger.info('Відкриваю сайт Gameloft');
    await page.goto(config.asphalt.shopUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.runtime.navigationTimeoutMs
    });

    const title = await page.title().catch(() => '');
    logger.success(`Playwright працює. Поточна сторінка: ${page.url()}`);
    if (title) logger.info(`Заголовок сторінки: ${title}`);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  logger.error(`Healthcheck не пройдено: ${error.message}`);
  if (error.stack) logger.debug({ error }, 'Healthcheck stack trace');
  process.exitCode = 1;
});
