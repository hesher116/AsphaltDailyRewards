const { chromium } = require('playwright');
const fs = require('fs/promises');
const config = require('../config');
const selectors = require('./selectors');
const logger = require('../utils/logger');
const { nowIso } = require('../utils/time');

class AuthFlow {
  constructor(sessionRepository, statusReporter) {
    this.sessionRepository = sessionRepository;
    this.statusReporter = statusReporter;
    this.context = null;
    this.page = null;
    this.pendingOtp = false;
    this.lastOtp = null;
  }

  async init() {
    if (this.context && this.page) return this.page;
    await fs.mkdir(config.browser.profileDir, { recursive: true });

    this.report('Запускаю браузер');
    logger.debug({ headless: config.browser.headless, profileDir: config.browser.profileDir }, 'Параметри браузера');

    const launchOptions = {
      headless: config.browser.headless,
      viewport: config.browser.viewport,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        ...config.browser.extraArgs
      ]
    };
    if (config.browser.executablePath) {
      launchOptions.executablePath = config.browser.executablePath;
    }

    this.context = await chromium.launchPersistentContext(config.browser.profileDir, launchOptions);

    this.context.on('close', () => {
      this.sessionRepository.update({ activeBrowserSession: false });
      this.context = null;
      this.page = null;
    });

    this.page = this.context.pages().find((page) => !page.isClosed()) || await this.context.newPage();
    this.page.setDefaultTimeout(config.runtime.selectorTimeoutMs);
    this.page.setDefaultNavigationTimeout(config.runtime.navigationTimeoutMs);
    this.sessionRepository.update({ activeBrowserSession: true });
    return this.page;
  }

  getPage() {
    if (!this.page) {
      throw new Error('Browser page is not initialized');
    }
    return this.page;
  }

  async ensureBrowser() {
    return this.init();
  }

  async gotoShop(waitUntil = 'domcontentloaded') {
    await this.ensureBrowser();
    const page = this.getPage();
    this.report('Відкриваю сайт Gameloft');
    await page.goto(config.asphalt.shopUrl, {
      waitUntil,
      timeout: config.runtime.navigationTimeoutMs
    });
    await page.waitForTimeout(2500);
  }

  async isLoggedIn() {
    await this.ensureBrowser();
    const page = this.getPage();
    this.report('Перевіряю, чи сесія ще активна');
    if (!page.url().includes('Asphalt_Legends')) {
      await this.gotoShop();
    }

    const loginButton = page.locator(selectors.loginButton).first();
    const visible = await loginButton.isVisible({ timeout: 5000 }).catch(() => false);
    const loggedIn = !visible;
    this.report(loggedIn ? 'Сесія активна, логін не потрібен' : 'Сесія неактивна, потрібен вхід', loggedIn ? 'success' : 'warn');
    return loggedIn;
  }

  async startLogin() {
    await this.ensureBrowser();
    const page = this.getPage();
    this.report('Починаю авторизацію');

    await this.gotoShop('networkidle');
    if (await this.isLoggedIn()) {
      this.pendingOtp = false;
      this.sessionRepository.setLoggedIn();
      await this.close();
      return { status: 'already_logged_in' };
    }

    await page.locator(selectors.loginButton).first().click();
    await page.waitForTimeout(3000);

    const gameloftLoginButton = page.locator(selectors.gameloftLoginButton).first();
    if (await gameloftLoginButton.isVisible().catch(() => false)) {
      await gameloftLoginButton.click();
      await page.waitForTimeout(2000);
    }

    const emailInput = page.locator(selectors.emailInput).first();
    await emailInput.waitFor({ state: 'visible', timeout: config.runtime.selectorTimeoutMs });
    this.report('Вводжу email');
    await emailInput.fill(config.asphalt.email);
    await emailInput.press('Enter');
    await page.waitForTimeout(2000);

    const continueButton = page.locator(selectors.continueButton).first();
    if (await continueButton.isVisible().catch(() => false)) {
      await continueButton.click();
    }

    this.pendingOtp = true;
    this.lastOtp = null;
    this.sessionRepository.setWaitingOtp();
    this.report('Очікую OTP-код');
    return { status: 'need_otp', waitingOtpSince: nowIso() };
  }

  async submitOtp(otp) {
    const cleanOtp = String(otp || '').trim();
    if (!/^\d{4,8}$/.test(cleanOtp)) {
      return { status: 'invalid_format', success: false };
    }
    if (!this.pendingOtp && this.lastOtp === cleanOtp) {
      return { status: 'duplicate_otp', success: false };
    }
    await this.ensureBrowser();

    this.lastOtp = cleanOtp;
    const page = this.getPage();
    this.report('OTP отримано, підтверджую вхід');

    try {
      await page.waitForSelector(selectors.visibleInput, { timeout: 10000 });
      const otpInput = page.locator(selectors.visibleInput).first();
      await otpInput.fill(cleanOtp);
      await otpInput.press('Enter');
      await page.waitForTimeout(1000);

      const submitButton = page.locator(selectors.otpSubmitButton).first();
      if (await submitButton.isVisible().catch(() => false)) {
        await submitButton.click();
      }

      await page.waitForTimeout(5000);
      const loggedIn = await this.isLoggedIn();
      if (!loggedIn) {
        this.pendingOtp = true;
        this.sessionRepository.setWaitingOtp();
        this.report('OTP не спрацював, очікую новий код', 'warn');
        return { status: 'otp_failed', success: false };
      }

      this.pendingOtp = false;
      this.sessionRepository.setLoggedIn();
      this.report('Вхід успішний', 'success');
      await this.close();
      return { status: 'logged_in', success: true };
    } catch (error) {
      logger.warn('Не вдалося підтвердити OTP');
      logger.debug({ error }, 'OTP submit failed');
      this.pendingOtp = true;
      this.sessionRepository.setWaitingOtp();
      return { status: 'otp_error', success: false, error: error.message };
    }
  }

  async close() {
    this.sessionRepository.update({ activeBrowserSession: false });
    if (this.context) {
      await this.context.close().catch((error) => {
        logger.warn('Не вдалося акуратно закрити браузер');
        logger.debug({ error }, 'Failed to close browser context');
      });
    }
    this.context = null;
    this.page = null;
  }

  async closeIfIdle() {
    if (!this.pendingOtp) {
      await this.close();
    }
  }

  report(message, level = 'info') {
    if (this.statusReporter) this.statusReporter.report(message, level);
    else if (level === 'success') logger.success(message);
    else if (level === 'warn') logger.warn(message);
    else if (level === 'error') logger.error(message);
    else logger.info(message);
  }
}

module.exports = AuthFlow;
