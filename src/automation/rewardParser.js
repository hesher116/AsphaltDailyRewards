const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const config = require('../config');
const selectors = require('./selectors');
const logger = require('../utils/logger');
const { ensureDir } = require('../utils/fileCleanup');
const { claimReward, closeCookieNotice, extractRewardNameFromText } = require('./checkoutFlow');

function safeRewardName(text, fallback) {
  const compact = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\bFree\b/gi, '')
    .replace(/\bClaim\b/gi, '')
    .trim();
  return compact || fallback;
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

    const card = await findRewardCardForButton(button);
    const cardVisible = await card.isVisible({ timeout: 1000 }).catch(() => false);
    if (!cardVisible) continue;

    matches.push({ button, card });
  }

  return matches;
}

async function findRewardCardForButton(button) {
  const candidates = [
    'xpath=ancestor::*[.//img and .//*[contains(normalize-space(), "Free Gift")] and .//*[contains(normalize-space(), "Purchase limit")]][1]',
    'xpath=ancestor::*[.//img and .//*[contains(normalize-space(), "Free Gift")]][1]',
    'xpath=ancestor::*[.//img][1]'
  ];

  for (const selector of candidates) {
    const card = button.locator(selector);
    if (await card.isVisible({ timeout: 500 }).catch(() => false)) return card;
  }

  return button.locator('xpath=ancestor::*[1]');
}

async function hasDailyGiftSection(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  return /Free Daily Gift|Daily Gift|Free Gift/i.test(bodyText);
}

async function findCurrentFreeReward(page, index, reportStatus) {
  const rewards = await findAvailableRewards(page, reportStatus);
  const reward = rewards[0];
  if (!reward) {
    const sectionFound = await hasDailyGiftSection(page);
    throw new Error(sectionFound
      ? 'Daily gifts section was found, but no available Free buttons were visible'
      : 'Daily gifts section was not found on the shop page');
  }

  return {
    ...reward,
    index
  };
}

async function findAvailableRewards(page, reportStatus) {
  await scrollForRewards(page);
  await closeCookieNotice(page);
  const matches = await findDailyFreeGiftButtons(page);
  if (reportStatus) {
    reportStatus(`Знайшов ${matches.length} доступних Free Gift карток`);
  }

  const rewards = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const rawText = await match.card.innerText({ timeout: 5000 }).catch(() => '');
    const imageUrl = await match.card.locator(selectors.rewardImage).first().getAttribute('src').catch(() => null);
    const fallbackName = `Daily reward ${i + 1}`;
    rewards.push({
      index: i + 1,
      freeButton: match.button,
      card: match.card,
      name: safeRewardName(rawText, fallbackName),
      imageUrl
    });
  }

  return rewards;
}

async function claimDiscoveredReward(page, reward, reportStatus) {
  let imagePath = null;
  let imageWarning = null;

  try {
    imagePath = await saveImageFromUrl(page, reward.imageUrl, reward.index);
  } catch (error) {
    imageWarning = error.message;
    logger.warn('Не вдалося зберегти зображення подарунка');
    logger.debug({ error, imageUrl: reward.imageUrl }, 'Reward image was not saved');
  }

  const claimResult = await claimReward(page, reward, reportStatus);

  if (!imagePath) {
    const successImageUrl = await page.locator(selectors.rewardImage).first().getAttribute('src').catch(() => null);
    if (successImageUrl && successImageUrl !== reward.imageUrl) {
      try {
        imagePath = await saveImageFromUrl(page, successImageUrl, reward.index);
      } catch (error) {
        imageWarning = imageWarning || error.message;
        logger.warn('Не вдалося зберегти зображення подарунка зі сторінки підтвердження');
        logger.debug({ error, imageUrl: successImageUrl }, 'Reward confirmation image was not saved');
      }
    }
  }

  return {
    index: reward.index,
    name: claimResult.rewardName,
    imageUrl: reward.imageUrl,
    imagePath,
    imageWarning,
    checkoutUrl: claimResult.checkoutUrl,
    successUrl: claimResult.successUrl
  };
}

async function parseAndClaimNextReward(page, index, reportStatus) {
  const reward = await findCurrentFreeReward(page, index, reportStatus);
  if (reportStatus) {
    reportStatus(`Обрав подарунок ${index}: ${reward.name}`);
  }
  return claimDiscoveredReward(page, reward, reportStatus);
}

module.exports = {
  claimDiscoveredReward,
  findAvailableRewards,
  parseAndClaimNextReward,
  extractRewardNameFromText
};
