const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const config = require('../config');
const selectors = require('./selectors');
const logger = require('../utils/logger');
const { ensureDir } = require('../utils/fileCleanup');

function safeRewardName(text, fallback) {
  const compact = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\bFree\b/gi, '')
    .replace(/\bClaim\b/gi, '')
    .trim();
  return compact || fallback;
}

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

async function scrollForRewards(page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i += 1) {
      window.scrollBy(0, 420);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
  await page.waitForTimeout(800);
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

async function waitForCheckoutReady(page) {
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
      logger.warn('Checkout сторінка ще не завантажилась, оновлюю її');
      logger.debug({ error: error.message, attempt }, 'Checkout page was not ready');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: config.runtime.navigationTimeoutMs }).catch(() => {});
      await page.waitForTimeout(3000);
    }
  }
}

async function saveImageFromUrl(page, imageUrl, index) {
  if (!imageUrl) return null;

  const dateFolder = new Date().toISOString().slice(0, 10);
  const targetDir = path.join(config.storage.rewardImagesDir, dateFolder);
  await ensureDir(targetDir);

  const resolvedUrl = new URL(imageUrl, page.url()).toString();
  const response = await page.request.get(resolvedUrl, { timeout: config.runtime.navigationTimeoutMs });
  if (!response.ok()) {
    throw new Error(`Image download failed with status ${response.status()}`);
  }

  const contentType = response.headers()['content-type'] || '';
  const extension = contentType.includes('png')
    ? '.png'
    : contentType.includes('webp')
      ? '.webp'
      : contentType.includes('jpeg') || contentType.includes('jpg')
        ? '.jpg'
        : path.extname(new URL(resolvedUrl).pathname) || '.img';

  const hash = crypto.createHash('sha1').update(`${Date.now()}-${index}-${resolvedUrl}`).digest('hex').slice(0, 10);
  const filePath = path.join(targetDir, `reward-${index}-${hash}${extension}`);
  await fs.writeFile(filePath, await response.body());
  return filePath;
}

async function findDailyFreeGiftButtons(page) {
  const buttons = page.locator('button');
  const count = await buttons.count();
  const matches = [];

  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;

    const text = await button.innerText({ timeout: 1000 }).catch(() => '');
    const compact = text.replace(/\s+/g, ' ').trim();
    if (!/\bFree\b/i.test(compact)) continue;
    if (/Free Daily Gift/i.test(compact)) continue;

    const card = button.locator('xpath=ancestor::*[.//img and .//*[contains(normalize-space(), "Free Gift")] and .//*[contains(normalize-space(), "Purchase limit")]][1]');
    const cardVisible = await card.isVisible({ timeout: 1000 }).catch(() => false);
    if (!cardVisible) continue;

    matches.push({ button, card });
  }

  return matches;
}

async function findCurrentFreeReward(page, index) {
  await scrollForRewards(page);
  await closeCookieNotice(page);
  const rewards = await findDailyFreeGiftButtons(page);
  const reward = rewards[index - 1];
  if (!reward) {
    throw new Error(`Daily free gift #${index} button was not found`);
  }

  const rawText = await reward.card.innerText({ timeout: 5000 }).catch(() => '');
  const imageUrl = await reward.card.locator(selectors.rewardImage).first().getAttribute('src').catch(() => null);

  return {
    index,
    freeButton: reward.button,
    name: safeRewardName(rawText, `Daily reward #${index}`),
    imageUrl
  };
}

async function claimReward(page, reward) {
  await reward.freeButton.scrollIntoViewIfNeeded().catch(() => {});
  await reward.freeButton.click();

  await waitForCheckoutReady(page);

  const claimButton = page.locator(selectors.claimButton).first();
  await claimButton.waitFor({ state: 'visible', timeout: config.runtime.selectorTimeoutMs });
  const orderName = await readClaimedRewardName(page, reward.name);
  await claimButton.scrollIntoViewIfNeeded().catch(() => {});
  await claimButton.click();

  await page.waitForURL('**/purchase-success**', { timeout: config.runtime.claimTimeoutMs });
  await page.waitForTimeout(1500);
  return orderName;
}

async function readClaimedRewardName(page, fallback) {
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return extractRewardNameFromText(bodyText) || fallback;
}

async function parseAndClaimNextReward(page, index) {
  const reward = await findCurrentFreeReward(page, index);
  let imagePath = null;
  let imageWarning = null;

  try {
    imagePath = await saveImageFromUrl(page, reward.imageUrl, index);
  } catch (error) {
    imageWarning = error.message;
    logger.warn('Не вдалося зберегти зображення подарунка');
    logger.debug({ error, imageUrl: reward.imageUrl }, 'Reward image was not saved');
  }

  const claimedName = await claimReward(page, reward);

  if (!imagePath) {
    const successImageUrl = await page.locator(selectors.rewardImage).first().getAttribute('src').catch(() => null);
    if (successImageUrl && successImageUrl !== reward.imageUrl) {
      try {
        imagePath = await saveImageFromUrl(page, successImageUrl, index);
      } catch (error) {
        imageWarning = imageWarning || error.message;
        logger.warn('Не вдалося зберегти зображення подарунка зі сторінки підтвердження');
        logger.debug({ error, imageUrl: successImageUrl }, 'Reward confirmation image was not saved');
      }
    }
  }

  return {
    index,
    name: claimedName,
    imageUrl: reward.imageUrl,
    imagePath,
    imageWarning
  };
}

module.exports = {
  parseAndClaimNextReward,
  extractRewardNameFromText
};
