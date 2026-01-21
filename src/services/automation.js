const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

class AsphaltAutomation {
    constructor(userEmail, telegramId) {
        this.email = userEmail;
        this.telegramId = telegramId;
        this.context = null;
        this.page = null;
        this.profileDir = path.join(process.cwd(), 'browser_profiles', String(this.telegramId));
    }

    log(action, status = '', type = 'info') {
        const msg = `[${this.telegramId}] ${action.toUpperCase()}`;
        const details = status ? ` -> ${status}` : '';
        if (type === 'success') logger.success(msg, details);
        else if (type === 'warn') logger.warn(msg, details);
        else if (type === 'error') logger.error(msg, details);
        else logger.info(msg, details);
    }

    async init(headless = false) {
        this.log('ініціалізація', `headless: ${headless}`);
        await fs.mkdir(this.profileDir, { recursive: true }).catch(() => { });

        this.context = await chromium.launchPersistentContext(this.profileDir, {
            headless,
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            args: ['--disable-blink-features=AutomationControlled']
        });

        this.page = this.context.pages().length > 0 ? this.context.pages()[0] : await this.context.newPage();
    }

    async randomDelay(min = 1000, max = 3000) {
        const delay = Math.floor(Math.random() * (max - min + 1) + min);
        await this.page.waitForTimeout(delay);
    }

    async humanScroll() {
        this.log('скролінг', 'імітація поведінки людини');
        await this.page.evaluate(async () => {
            const distance = 250;
            const delay = 60;
            for (let i = 0; i < 6; i++) {
                window.scrollBy(0, distance);
                await new Promise(r => setTimeout(r, delay));
            }
        });
        await this.randomDelay(1000, 2000);
    }

    async startLogin() {
        try {
            this.log('авторизація', 'початок gameloft auth');
            await this.page.goto('https://shop.gameloft.com/games/Asphalt_Legends', { waitUntil: 'networkidle', timeout: 60000 });
            await this.page.waitForTimeout(5000);

            const loginBtn = this.page.locator('button:has-text("Log in")').first();
            if (await loginBtn.isHidden()) {
                this.log('авторизація', 'вже авторизовано');
                return "ALREADY_LOGGED";
            }

            await loginBtn.click();
            await this.page.waitForSelector('input[type="email"]', { timeout: 15000 });
            await this.page.fill('input[type="email"]', this.email);
            const submitBtn = this.page.locator('button:has-text("Log in")').last();
            await submitBtn.click();

            this.log('авторизація', 'запит OTP коду');
            return "NEED_OTP";
        } catch (e) {
            this.log('помилка_входу', e.message);
            return e.message;
        }
    }

    async submitOtp(otp) {
        try {
            this.log('otp', `відправка коду`);
            await this.page.waitForSelector('input[maxlength="5"]', { timeout: 10000 });
            await this.page.fill('input[maxlength="5"]', otp);
            await this.page.waitForTimeout(5000);
            const stillHasOtp = await this.page.locator('input[maxlength="5"]').isVisible();
            const success = !stillHasOtp;
            this.log('otp', success ? 'успішно' : 'помилка');
            return success;
        } catch (e) {
            this.log('помилка_otp', e.message);
            return false;
        }
    }

    async collectRewards() {
        this.log('збір', 'початок процесу');
        const storeUrl = 'https://shop.gameloft.com/games/Asphalt_Legends';

        try {
            if (!this.page.url().includes('Asphalt_Legends')) {
                await this.page.goto(storeUrl, { waitUntil: 'networkidle' });
            }
            await this.page.waitForTimeout(5000);

            let loginBtn = this.page.locator('button:has-text("Log in")').first();
            if (await loginBtn.isVisible()) {
                this.log('сесія', 'спроба відновлення');
                await this.page.reload({ waitUntil: 'networkidle' });
                await this.page.waitForTimeout(5000);
                loginBtn = this.page.locator('button:has-text("Log in")').first();
                if (await loginBtn.isVisible()) {
                    this.log('сесія', 'втрачена');
                    return "SESSION_LOST";
                }
            }

            this.log('сесія', 'активна');
            let collected = 0;
            const rewardImages = [];

            for (let i = 1; i <= 2; i++) {
                if (this.page.url().includes('purchase-success')) {
                    await this.page.goto(storeUrl, { waitUntil: 'networkidle' });
                    await this.randomDelay(1000, 2000);
                }

                await this.humanScroll();

                const freeLocator = this.page.locator('div:text-is("Free")').first();
                try {
                    await freeLocator.waitFor({ state: 'visible', timeout: 5000 });
                    const card = freeLocator.locator('xpath=./parent::div/parent::div/parent::div');

                    const img = card.locator('img[src*="webstore_"]').first();
                    const imgUrl = await img.getAttribute('src').catch(() => null);
                    if (imgUrl) rewardImages.push(imgUrl);

                    this.log('подарунок', `знайдено #${i}`);
                    await freeLocator.click();

                    const claimBtn = this.page.locator('button:has-text("Claim"), [class*="claim"], div:text-is("Claim")').first();
                    await claimBtn.waitFor({ state: 'visible', timeout: 5000 });
                    await claimBtn.click();

                    collected++;
                    this.log('подарунок', `отримано #${i}`);
                    await this.page.waitForURL('**/purchase-success**', { timeout: 8000 }).catch(() => { });
                    await this.randomDelay(2000, 3000);
                } catch (e) {
                    this.log('подарунок', `подарунок #${i} не знайдено`);
                    break;
                }
            }
            return { count: collected, rewardImages };
        } catch (e) {
            this.log('помилка_збору', e.message);
            return { count: 0, rewardImages: [] };
        }
    }

    async close() {
        if (this.context) {
            this.log('browser', 'closing context');
            await this.context.close().catch(() => { });
        }
        return true;
    }
}

module.exports = AsphaltAutomation;
