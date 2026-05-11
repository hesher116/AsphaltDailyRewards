const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { chromium, firefox } = require('playwright');
const config = require('../config');
const logger = require('./logger');
const { ensureDir } = require('./fileCleanup');

function mimeFromBuffer(buffer, filePath) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

async function imageDataUrl(filePath) {
  const buffer = await fs.readFile(filePath);
  return `data:${mimeFromBuffer(buffer, filePath)};base64,${buffer.toString('base64')}`;
}

function collagePathFor(imagePaths) {
  const hash = crypto
    .createHash('sha1')
    .update(imagePaths.join('|'))
    .digest('hex')
    .slice(0, 12);
  return path.join(config.storage.rewardImagesDir, 'collages', `recent-${hash}.png`);
}

async function createImageCollage(imagePaths) {
  const existingPaths = [];
  for (const imagePath of imagePaths || []) {
    if (!imagePath) continue;
    await fs.access(imagePath).then(() => existingPaths.push(imagePath)).catch(() => {});
  }

  if (existingPaths.length <= 1) return existingPaths[0] || null;

  const outputPath = collagePathFor(existingPaths);
  if (await fs.access(outputPath).then(() => true).catch(() => false)) return outputPath;

  await ensureDir(path.dirname(outputPath));
  const dataUrls = await Promise.all(existingPaths.slice(0, 4).map((imagePath) => imageDataUrl(imagePath)));
  const columns = dataUrls.length === 1 ? 1 : 2;
  const rows = Math.ceil(dataUrls.length / columns);
  const width = 900;
  const tileWidth = width / columns;
  const tileHeight = 520;
  const height = tileHeight * rows;
  const html = [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<style>',
    'body{margin:0;background:#111;color:white;font-family:Arial,sans-serif;}',
    `.grid{width:${width}px;height:${height}px;display:grid;grid-template-columns:repeat(${columns},1fr);}`,
    '.tile{position:relative;overflow:hidden;background:#181818;display:flex;align-items:center;justify-content:center;}',
    '.tile img{width:100%;height:100%;object-fit:contain;}',
    '.label{position:absolute;left:14px;top:12px;background:rgba(0,0,0,.62);padding:6px 10px;border-radius:6px;font-size:22px;font-weight:700;}',
    '</style></head><body><div class="grid">',
    ...dataUrls.map((dataUrl, index) => `<div class="tile"><span class="label">Reward ${index + 1}</span><img src="${dataUrl}"></div>`),
    '</div></body></html>'
  ].join('');

  const engine = config.browser.engine === 'firefox' ? firefox : chromium;
  let browser;
  try {
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: outputPath, fullPage: true });
    return outputPath;
  } catch (error) {
    logger.warn('Failed to create reward image collage');
    logger.debug({ error }, 'Reward image collage failed');
    return existingPaths[0] || null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  createImageCollage
};
