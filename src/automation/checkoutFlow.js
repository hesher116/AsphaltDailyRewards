const config = require('../config');
const selectors = require('./selectors');
const logger = require('../utils/logger');

function extractRewardNameFromText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const directQuantity = lines.find((line) => /^[•\-*\s]*(\d+)\s*x\s+.+/i.test(line));
  if (directQuantity) {
    return directQuantity.replace(/^[•\-*\s]*(\d+)\s*x\s+/i, '$1x ');
  }

  const quantityIndex = lines.findIndex((line) => /^quantity$/i.test(line));
  if (quantityIndex > 0) {
    const name = lines[quantityIndex - 1];
    const quantity = lines[quantityIndex + 1];
    if (/^\d+$/.test(quantity || '') && name && !/^(free|claim|order summary|total)$/i.test(name)) {
      return `${quantity}x ${name}`;
    }
  }

  return lines.find((line) => {
    if (/^(free|claim|order summary|summary|total|continue|done|back|price|quantity)$/i.test(line)) return false;
    if (/cookies?|privacy policy|terms of use|personal data|legitimate business interest|with your agreement/i.test(line)) return false;
    if (line.length > 120) return false;
    if (/^\$|^0$/.test(line)) return false;
    return /[a-zа-я_]/i.test(line);
  }) || null;
}

async function closeCookieNotice(page) {
  const buttons = [
    'button:has-text("Disagree and close")',
    'button:has-text("Agree and close")',
    'text="Disagree and close"',
    'text="Agree and close"'
  ];

  for (const selector of buttons) {
    const button = page.locator(selector).first();
    if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(700);
      return;
    }
  }
}

async function waitForMountedApp(page) {
  const deadline = Date.now() + config.runtime.navigationTimeoutMs;
  let lastRootText = '';

  while (Date.now() < deadline) {
    await closeCookieNotice(page);

    const rootInfo = await page.evaluate(() => {
      const root = document.querySelector('#root');
      return {
        hasRoot: Boolean(root),
        childCount: root ? root.children.length : 0,
        text: root ? root.innerText.slice(0, 500) : ''
      };
    }).catch(() => ({ hasRoot: false, childCount: 0, text: '' }));

    lastRootText = rootInfo.text || lastRootText;
    if (rootInfo.hasRoot && rootInfo.childCount > 0 && rootInfo.text.trim().length > 20) {
      return;
    }

    await page.waitForTimeout(1500);
  }

  throw new Error(`Checkout app did not finish loading. Last root text: ${lastRootText || 'empty'}`);
}

async function waitForCheckoutReady(page, reportStatus) {
  await page.waitForURL('**/purchase-checkout/**', { timeout: config.runtime.navigationTimeoutMs });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await waitForMountedApp(page);
      await page.locator(selectors.orderSummary).first().waitFor({
        state: 'visible',
        timeout: config.runtime.selectorTimeoutMs
      });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      const message = 'Checkout сторінка ще не завантажилась, оновлюю її';
      if (reportStatus) reportStatus(message, 'warn');
      else logger.warn(message);
      logger.debug({ error: error.message, attempt }, 'Checkout page was not ready');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: config.runtime.navigationTimeoutMs }).catch(() => {});
      await page.waitForTimeout(3000);
    }
  }
}

async function readClaimedRewardName(page, fallback) {
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return extractRewardNameFromText(bodyText) || fallback;
}

async function claimReward(page, reward, reportStatus) {
  await reward.freeButton.scrollIntoViewIfNeeded().catch(() => {});
  await reward.freeButton.click();

  await waitForCheckoutReady(page, reportStatus);
  const checkoutUrl = page.url();

  const claimButton = page.locator(selectors.claimButton).first();
  await claimButton.waitFor({ state: 'visible', timeout: config.runtime.selectorTimeoutMs });
  const orderName = await readClaimedRewardName(page, reward.name);
  await claimButton.scrollIntoViewIfNeeded().catch(() => {});
  if (reportStatus) reportStatus('Натискаю Claim на checkout сторінці');
  await claimButton.click();

  await page.waitForURL('**/purchase-success**', { timeout: config.runtime.claimTimeoutMs });
  await page.waitForTimeout(1500);
  return {
    rewardName: orderName,
    checkoutUrl,
    successUrl: page.url()
  };
}

module.exports = {
  claimReward,
  closeCookieNotice,
  extractRewardNameFromText,
  waitForCheckoutReady
};
