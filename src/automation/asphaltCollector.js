const config = require('../config');
const selectors = require('./selectors');
const { claimDiscoveredReward, findAvailableRewards } = require('./rewardParser');
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
    if (!bodyText || bodyText.length < 20 || !/Asphalt Legends|Free Daily Gift|Log in|Gameloft/i.test(bodyText)) {
      throw new Error('Selector health check failed: shop page body is empty');
    }
  }

  async collect(job = {}) {
    const startedAt = nowIso();
    logger.debug({ startedAt, job }, 'Starting reward collection');
    this.report('Починаю збір подарунків');

    await this.authFlow.gotoShop();
    const page = this.authFlow.getPage();
    this.report(`Поточна сторінка: ${page.url()}`);
    const sessionOk = await this.ensureSession();
    if (!sessionOk) {
      return {
        status: 'session_lost',
        rewards: [],
        imagePaths: [],
        description: 'Session lost before reward collection',
        technicalStatus: 'auth_required',
        jobId: job.id || null,
        source: job.source || null
      };
    }
    await this.selectorHealthCheck();

    let expectedCount = 0;
    const rewards = [];
    const errors = [];

    const initialRewards = await findAvailableRewards(page, (message, level) => this.report(message, level));
    expectedCount = initialRewards.length;
    if (expectedCount === 0) {
      this.report('Подарунки зараз недоступні', 'warn');
      return {
        status: 'unavailable',
        rewards: [],
        imagePaths: [],
        description: 'Daily rewards are not available yet',
        technicalStatus: 'available 0',
        collectedCount: 0,
        expectedCount: 0,
        jobId: job.id || null,
        jobLabel: job.label || null,
        source: job.source || null
      };
    }

    const maxRewards = Math.max(1, config.runtime.maxRewardsPerCollect);
    if (expectedCount > maxRewards) {
      this.report(`Знайдено ${expectedCount} rewards, safety limit ${maxRewards}. Зберу тільки до ліміту.`, 'warn');
    }

    const targetCount = Math.min(expectedCount, maxRewards);
    for (let index = 1; index <= targetCount; index += 1) {
      try {
        if (page.url().includes('purchase-success')) {
          await this.authFlow.gotoShop();
          this.report(`Повернувся в магазин: ${page.url()}`);
        }

        const availableBefore = await findAvailableRewards(page, (message, level) => this.report(message, level));
        if (availableBefore.length === 0) break;

        const rewardToClaim = { ...availableBefore[0], index };
        this.report(`Забираю подарунок ${index}/${expectedCount}: ${rewardToClaim.name}`);
        const reward = await claimDiscoveredReward(page, rewardToClaim, (message, level) => this.report(message, level));

        await this.authFlow.gotoShop();
        this.report(`Перевіряю магазин після Claim: ${page.url()}`);
        const availableAfter = await findAvailableRewards(page, (message, level) => this.report(message, level));
        if (availableAfter.length >= availableBefore.length) {
          throw new Error(`Post-claim verification failed: available rewards did not decrease (${availableBefore.length} -> ${availableAfter.length})`);
        }

        rewards.push({
          ...reward,
          verifiedAt: nowIso(),
          availableBefore: availableBefore.length,
          availableAfter: availableAfter.length
        });
        this.report(`Подарунок ${index}/${expectedCount} підтверджено після Claim`, 'success');
        logger.debug({ reward: reward.name }, 'Reward collected');
      } catch (error) {
        errors.push(`Reward ${index}: ${error.message}`);
        logger.debug({ error: error.message, index }, 'No more available rewards or claim failed');
        this.report(`Подарунок ${index} не підтверджено: ${error.message.split('\n')[0]}`, 'warn');
        const snapshotPath = await savePageSnapshot(page, `reward-${index}-failed`);
        if (snapshotPath) {
          logger.warn(`Збережено debug snapshot подарунка: ${snapshotPath}`);
        }
        break;
      }
    }

    const imagePaths = rewards.map((reward) => reward.imagePath).filter(Boolean);
    const imageWarnings = rewards.map((reward) => reward.imageWarning).filter(Boolean);

    if (rewards.length === expectedCount && expectedCount === 1) {
      this.report('Зібрано 1 reward. Потрібна ручна перевірка в Telegram.', 'warn');
      const snapshotPath = await savePageSnapshot(page, 'needs-review-one-reward');
      if (snapshotPath) {
        logger.warn(`Збережено needs_review snapshot: ${snapshotPath}`);
      }
      return {
        status: 'needs_review',
        rewards,
        imagePaths,
        description: 'Collected 1 verified reward; manual check requested',
        error: snapshotPath
          ? `Only one reward was available; please verify manually. Snapshot: ${snapshotPath}`
          : 'Only one reward was available; please verify manually',
        technicalStatus: [
          imageWarnings.length ? `verified 1/1; image warnings: ${imageWarnings.join('; ')}` : 'verified 1/1',
          snapshotPath ? `needs_review_snapshot=${snapshotPath}` : ''
        ].filter(Boolean).join('; '),
        collectedCount: rewards.length,
        expectedCount,
        verifiedAt: rewards[rewards.length - 1].verifiedAt,
        jobId: job.id || null,
        jobLabel: job.label || null,
        source: job.source || null
      };
    }

    if (rewards.length === expectedCount && expectedCount > 1) {
      this.report('Збір завершено успішно', 'success');
      return {
        status: 'success',
        rewards,
        imagePaths,
        description: `Collected ${rewards.length} verified daily rewards`,
        technicalStatus: imageWarnings.length ? `verified ${rewards.length}/${expectedCount}; image warnings: ${imageWarnings.join('; ')}` : `verified ${rewards.length}/${expectedCount}`,
        collectedCount: rewards.length,
        expectedCount,
        verifiedAt: rewards[rewards.length - 1].verifiedAt,
        jobId: job.id || null,
        jobLabel: job.label || null,
        source: job.source || null
      };
    }

    if (rewards.length > 0) {
      this.report('Зібрано частину подарунків', 'warn');
      return {
        status: 'partial',
        rewards,
        imagePaths,
        description: `Collected ${rewards.length}/${expectedCount} verified daily rewards`,
        error: errors.join('; ') || null,
        technicalStatus: `verified ${rewards.length}/${expectedCount}`,
        collectedCount: rewards.length,
        expectedCount,
        verifiedAt: rewards[rewards.length - 1].verifiedAt,
        jobId: job.id || null,
        jobLabel: job.label || null,
        source: job.source || null
      };
    }

    this.report('Подарунки зараз недоступні', 'warn');
    return {
      status: 'unavailable',
      rewards: [],
      imagePaths: [],
      description: 'Daily rewards are not available yet',
      error: errors.join('; ') || null,
      technicalStatus: `verified 0/${expectedCount}`,
      collectedCount: 0,
      expectedCount,
      jobId: job.id || null,
      jobLabel: job.label || null,
      source: job.source || null
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
