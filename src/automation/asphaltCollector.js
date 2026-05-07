const config = require('../config');
const selectors = require('./selectors');
const { parseAndClaimNextReward } = require('./rewardParser');
const logger = require('../utils/logger');
const { nowIso } = require('../utils/time');
const { savePageSnapshot } = require('../utils/debugSnapshot');

class AsphaltCollector {
  constructor(authFlow, sessionRepository, statusReporter) {
    this.authFlow = authFlow;
    this.sessionRepository = sessionRepository;
    this.statusReporter = statusReporter;
  }

  async ensureSession() {
    const page = this.authFlow.getPage();
    if (!page.url().includes('Asphalt_Legends')) {
      await this.authFlow.gotoShop();
    }

    let loginVisible = await page.locator(selectors.loginButton).first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!loginVisible) {
      this.sessionRepository.update({ authStatus: 'logged_in' });
      return true;
    }

    this.report('Сесія виглядає неактивною, перевіряю ще раз', 'warn');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: config.runtime.navigationTimeoutMs });
    await page.waitForTimeout(2500);
    loginVisible = await page.locator(selectors.loginButton).first().isVisible({ timeout: 5000 }).catch(() => false);
    if (loginVisible) {
      this.sessionRepository.setSessionLost();
      this.report('Потрібна повторна авторизація', 'warn');
      return false;
    }

    this.sessionRepository.update({ authStatus: 'logged_in' });
    return true;
  }

  async selectorHealthCheck() {
    const page = this.authFlow.getPage();
    await page.locator('body').waitFor({ state: 'visible', timeout: config.runtime.selectorTimeoutMs });
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (!bodyText || bodyText.length < 20) {
      throw new Error('Selector health check failed: shop page body is empty');
    }
  }

  async collect() {
    const startedAt = nowIso();
    logger.debug({ startedAt }, 'Starting reward collection');
    this.report('Починаю збір подарунків');

    await this.authFlow.gotoShop();
    const page = this.authFlow.getPage();
    const sessionOk = await this.ensureSession();
    if (!sessionOk) {
      return {
        status: 'session_lost',
        rewards: [],
        imagePaths: [],
        description: 'Session lost before reward collection',
        technicalStatus: 'auth_required'
      };
    }
    await this.selectorHealthCheck();

    const rewards = [];
    const errors = [];

    for (let index = 1; index <= 2; index += 1) {
      try {
        if (page.url().includes('purchase-success')) {
          await this.authFlow.gotoShop();
        }

        this.report(index === 1 ? 'Забираю перший подарунок' : 'Забираю другий подарунок');
        const reward = await parseAndClaimNextReward(page, index);
        rewards.push(reward);
        this.report(index === 1 ? 'Перший подарунок зібрано' : 'Другий подарунок зібрано', 'success');
        logger.debug({ reward: reward.name }, 'Reward collected');
      } catch (error) {
        errors.push(`Reward #${index}: ${error.message}`);
        logger.debug({ error: error.message, index }, 'No more available rewards or claim failed');
        const snapshotPath = await savePageSnapshot(page, `reward-${index}-failed`);
        if (snapshotPath) {
          logger.warn(`Збережено debug snapshot подарунка: ${snapshotPath}`);
        }
        break;
      }
    }

    const imagePaths = rewards.map((reward) => reward.imagePath).filter(Boolean);
    const imageWarnings = rewards.map((reward) => reward.imageWarning).filter(Boolean);

    if (rewards.length === 2) {
      this.report('Збір завершено успішно', 'success');
      return {
        status: 'success',
        rewards,
        imagePaths,
        description: 'Collected 2 daily rewards',
        technicalStatus: imageWarnings.length ? `collected 2/2; image warnings: ${imageWarnings.join('; ')}` : 'collected 2/2'
      };
    }

    if (rewards.length > 0) {
      this.report('Зібрано частину подарунків', 'warn');
      return {
        status: 'partial',
        rewards,
        imagePaths,
        description: `Collected ${rewards.length}/2 daily rewards`,
        error: errors.join('; ') || null,
        technicalStatus: `collected ${rewards.length}/2`
      };
    }

    this.report('Подарунки зараз недоступні', 'warn');
    return {
      status: 'unavailable',
      rewards: [],
      imagePaths: [],
      description: 'Daily rewards are not available yet',
      error: errors.join('; ') || null,
      technicalStatus: 'collected 0/2'
    };
  }

  report(message, level = 'info') {
    if (this.statusReporter) this.statusReporter.report(message, level);
    else if (level === 'success') logger.success(message);
    else if (level === 'warn') logger.warn(message);
    else if (level === 'error') logger.error(message);
    else logger.info(message);
  }
}

module.exports = AsphaltCollector;
