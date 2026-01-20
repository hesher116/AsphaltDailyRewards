const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

class AsphaltAutomation {
    constructor(userEmail, telegramId) {
        this.email = userEmail;
        this.telegramId = telegramId;
        this.context = null;
        this.page = null;
        this.profileDir = path.join(process.cwd(), 'browser_profiles', String(this.telegramId));
    }

    log(message) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`[${timestamp}] [${this.email}] ${message}`);
    }

    async init(headless = false) {
        this.log(`🚀 Ініціалізація профілю (headless: ${headless})...`);

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
        this.log("鼠标 Імітація скролінгу...");
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
        this.log("🔑 Крок 1: Завантаження сторінки...");
        await this.page.goto('https://shop.gameloft.com/games/Asphalt_Legends', { waitUntil: 'domcontentloaded' });

        const loginBtn = this.page.locator('button:has-text("Log in")').first();
        try {
            await loginBtn.waitFor({ state: 'visible', timeout: 5000 });
            this.log("Натискаю кнопку 'Log in'");
            await loginBtn.click();
        } catch (e) {
            const userNickname = this.page.locator('.user-nickname, .nickname, #user-nickname, .account-name').first();
            if (await userNickname.isVisible() || !(await loginBtn.isVisible())) {
                this.log("✅ Сесія вже активна.");
                return "ALREADY_LOGGED";
            }
        }

        const gameloftSignIn = this.page.locator('button:has-text("Sign in with Gameloft account")');
        try {
            await gameloftSignIn.waitFor({ state: 'visible', timeout: 5000 });
            await this.randomDelay(500, 1000);
            await gameloftSignIn.click({ force: true });
        } catch (e) { }

        const emailInput = this.page.locator('#email');
        try {
            await emailInput.waitFor({ state: 'visible', timeout: 4000 });
            await emailInput.fill(this.email);

            const rememberMe = this.page.locator('input[type="checkbox"], .remember-me').first();
            if (await rememberMe.isVisible()) {
                await rememberMe.check().catch(() => { });
            }

            await this.page.locator('button:has-text("Continue")').click();
            return "NEED_OTP";
        } catch (e) {
            return "FAILED: UI_NOT_READY";
        }
    }

    async submitOtp(code) {
        this.log(`📨 Введення OTP: ${code}`);
        const codeInput = this.page.locator('#auth-code');
        await codeInput.waitFor({ state: 'visible' });
        await codeInput.fill(code);
        await this.page.locator('button:has-text("Submit")').click();

        try {
            await this.page.waitForURL('**/Asphalt_Legends**', { timeout: 15000 });
            this.log("⏳ Фіналізація входу...");
            await this.page.waitForLoadState('networkidle');
            await this.page.locator('.user-nickname, .account-name, button:has-text("Log out")').first().waitFor({ timeout: 10000 }).catch(() => { });
            await this.randomDelay(5000, 8000);
        } catch (e) {
            this.log("⚠️ Затримка після OTP.");
        }

        await this.page.goto('https://shop.gameloft.com/games/Asphalt_Legends', { waitUntil: 'networkidle' });
        const loginBtn = this.page.locator('button:has-text("Log in")').first();
        return await loginBtn.isHidden();
    }

    async collectRewards() {
        this.log("🎁 Збір нагород...");
        const storeUrl = 'https://shop.gameloft.com/games/Asphalt_Legends';

        if (!this.page.url().includes('Asphalt_Legends')) {
            await this.page.goto(storeUrl, { waitUntil: 'networkidle' });
        }

        await this.page.waitForTimeout(5000);
        let loginBtn = this.page.locator('button:has-text("Log in")').first();
        if (await loginBtn.isVisible()) {
            this.log("ℹ️ Спроба відновити сесію через оновлення...");
            await this.page.reload({ waitUntil: 'networkidle' });
            await this.page.waitForTimeout(5000);
            loginBtn = this.page.locator('button:has-text("Log in")').first();
            if (await loginBtn.isVisible()) {
                this.log("❌ Сесія недійсна.");
                return "SESSION_LOST";
            }
        }

        this.log("✅ Сесія підтверджена.");
        let collected = 0;
        const screenshots = [];

        for (let i = 1; i <= 2; i++) {
            if (this.page.url().includes('purchase-success')) {
                await this.page.goto(storeUrl, { waitUntil: 'networkidle' });
                await this.randomDelay(1000, 2000);
            }

            await this.humanScroll();

            const freeLocator = this.page.locator('div:text-is("Free")').first();
            try {
                await freeLocator.waitFor({ state: 'visible', timeout: 5000 });
                const text = await freeLocator.innerText();
                if (text.trim() !== "Free") break;

                const card = freeLocator.locator('xpath=./parent::div/parent::div/parent::div');
                const shotPath = path.join(process.cwd(), `reward_${Date.now()}_${i}.png`);
                await card.screenshot({ path: shotPath }).catch(() => { });
                screenshots.push(shotPath);

                this.log(`Натискаю 'Free' #${i}`);
                await freeLocator.click();

                const claimBtn = this.page.locator('button:has-text("Claim"), [class*="claim"], div:text-is("Claim")').first();
                await claimBtn.waitFor({ state: 'visible', timeout: 5000 });
                await claimBtn.click();

                collected++;
                this.log(`✅ Нагорода #${i} Claimed!`);
                await this.page.waitForURL('**/purchase-success**', { timeout: 8000 }).catch(() => { });
                await this.randomDelay(2000, 3000);
            } catch (e) {
                this.log(`ℹ️ Подарунок #${i} не знайдено.`);
                break;
            }
        }
        return { count: collected, screenshots };
    }

    async close() {
        if (this.context) {
            this.log("🔌 Закриття контексту...");
            await this.context.close();
        }
        return true;
    }
}

module.exports = AsphaltAutomation;
