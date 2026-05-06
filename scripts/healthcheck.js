const config = require('../src/config');
const logger = require('../src/utils/logger');
const { ensureDir } = require('../src/utils/fileCleanup');
const { launchPersistentBrowserContext } = require('../src/automation/browserLauncher');

async function runStage(name, action) {
  logger.info(`Healthcheck: ${name}`);
  try {
    const result = await action();
    logger.success(`OK: ${name}${result ? ` - ${result}` : ''}`);
  } catch (error) {
    logger.error(`FAILED: ${name} - ${error.message}`);
    throw error;
  }
}

async function main() {
  logger.info('Перевіряю конфігурацію');

  if (!config.asphalt.shopUrl) {
    throw new Error('SHOP_URL порожній');
  }

  const profileDir = process.env.HEALTHCHECK_PROFILE_DIR || config.browser.profileDir;
  await ensureDir(profileDir);

  logger.info(`Запускаю ${config.browser.engine} у режимі HEADLESS=${config.browser.headless}`);
  logger.info(`Browser profile: ${profileDir}`);
  if (config.browser.executablePath) {
    logger.info(`Browser executable: ${config.browser.executablePath}`);
  }
  const context = await launchPersistentBrowserContext(profileDir);

  try {
    const page = context.pages().find((candidate) => !candidate.isClosed()) || await context.newPage();
    page.setDefaultTimeout(config.runtime.selectorTimeoutMs);
    page.setDefaultNavigationTimeout(config.runtime.navigationTimeoutMs);

    await runStage('about:blank', async () => {
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 });
      return page.url();
    });

    await runStage('local HTML render', async () => {
      await page.setContent('<!doctype html><title>local-ok</title><h1>ok</h1>');
      return await page.title();
    });

    await runStage('example.com navigation', async () => {
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: config.runtime.navigationTimeoutMs });
      return await page.title();
    });

    await runStage('Gameloft shop navigation', async () => {
      await page.goto(config.asphalt.shopUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.runtime.navigationTimeoutMs
      });
      return `${await page.title().catch(() => '')} ${page.url()}`.trim();
    });

    logger.success('Healthcheck пройдено повністю');
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  logger.error(`Healthcheck не пройдено: ${error.message}`);
  if (error.stack) logger.debug({ error }, 'Healthcheck stack trace');
  process.exitCode = 1;
});
