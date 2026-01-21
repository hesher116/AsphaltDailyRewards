# 🏎️ Asphalt Legends Daily Rewards Bot

![Banner](dashboard_header.png)

A professional, high-performance Telegram bot designed for automated daily reward collection from the **Gameloft Club** store for Asphalt Legends Unite. Built with reliability and user experience in mind.

## 🚀 Key Features

- **Automated Collection**: Automatically logs into Gameloft Club and claims all available "Free" rewards.
- **Persistent Sessions**: Uses independent browser profiles for each user, ensuring you only need to log in once.
- **Premium Dashboard**: A sleek, image-based dashboard inside Telegram for full control.
- **Multi-Account Support**: Premium users can link up to 3 different Gameloft emails.
- **Aggressive Cleanup**: Keeps your chat clean by maintaining only the dashboard and the latest response.
- **Admin Dashboard**: A web-based administrative panel for monitoring users, chat history, and global system status.
- **Colored Logging**: Professional terminal output with clear severity levels for easy monitoring.

## 🛠️ Tech Stack

- **Runtime**: Node.js
- **Automation**: Playwright (Chromium)
- **Telegram API**: Telegraf
- **Database**: SQLite3
- **Frontend**: Vanilla HTML/JS + Express (Admin Panel)

## 📋 Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/hesher116/AsphaltDailyRewards.git
   cd AsphaltDailyRewards
   ```

2. **Install dependencies**:
   ```bash
   npm install
   npx playwright install chromium
   ```

3. **Configure Environment**:
   Create a `.env` file in the root directory:
   ```env
   TELEGRAM_TOKEN=your_bot_token
   ADMIN_ID=your_telegram_id
   DASHBOARD_PORT=3000
   DATABASE_URL=database.sqlite
   ```

4. **Launch**:
   ```bash
   npm start
   ```

## 🏗️ Architecture

- `src/bot`: Telegram bot logic, scenes (login), and dashboard rendering.
- `src/api`: Administrative API and poller for background tasks.
- `src/services`: Core automation engine using Playwright.
- `src/utils`: Logging, message tracking, and helper utilities.
- `dashboard/`: Frontend assets for the Web Admin Panel.

## 🛡️ License

MIT License. Developed by [@hesher116](https://t.me/hesher116).
