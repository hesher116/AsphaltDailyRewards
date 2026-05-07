# Asphalt Daily Rewards

Telegram-controlled Playwright automation for collecting Asphalt Legends daily rewards.

The app is intentionally small: one Telegram bot, one scheduler, one browser automation service, and SQLite storage. It keeps a persistent Playwright browser profile on disk, so Gameloft sessions survive browser restarts.

## Features

- Telegram dashboard with inline controls
- OTP login through Gameloft ID
- Browser opens only when an action is needed
- Persistent browser profile for saved sessions
- Manual and scheduled reward collection
- Scheduler: 24 hours plus persisted random offset
- SQLite history and state
- Reward image saving with 3-day cleanup
- Debug HTML snapshots on collector crashes
- Linux/server friendly headless mode
- PM2 config for 24/7 deployment
- PM2 crash/reboot restart notification with auto-delete TTL
- Startup auto-collect if the last successful collect was more than 24h10m ago
- Heartbeat log/dashboard update so long-running mode is visibly alive

## Dashboard

The bot keeps one main dashboard message with `dashboard_header.png`, status text, and buttons.

Controls:

- `Увійти`
- `Перевірити сесію`
- `Зібрати подарунки`
- `Статус`
- `Історія`
- `Останні збори`

Dashboard shows:

- current status
- session state
- OTP state
- last successful collect
- next scheduled collect
- last 5 actions
- last 5 user-facing system messages

If the dashboard message is deleted or cannot be edited, run:

```text
/dashboard_reset
```

`Останні збори` shows the last 3 successful collections inside the same dashboard message. Telegram can edit one photo message, but cannot embed a full media group inside that same message, so this view switches the dashboard image to the first available reward image and lists all collected rewards in the caption.

## Requirements

- Node.js 20+
- Telegram bot token from `@BotFather`
- A Telegram chat id
- Gameloft account email
- Playwright Chromium browser

On constrained aarch64/proot Linux environments, Chromium may crash on real navigation. In that case use Firefox:

```env
BROWSER_ENGINE=firefox
```

## Installation

```bash
git clone git@github.com:hesher116/AsphaltDailyRewards.git
cd AsphaltDailyRewards
npm install
npx playwright install chromium
cp .env.example .env
```

If you plan to use Firefox:

```bash
npx playwright install firefox
```

Fill `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:replace_me
TELEGRAM_CHAT_ID=123456789
ASPHALT_EMAIL=you@example.com
HEADLESS=true
DEBUG=false
```

If Chromium closes unexpectedly on a phone/proot Linux server, use:

```env
BROWSER_ENGINE=firefox
```

To discover your chat id:

1. Set `TELEGRAM_BOT_TOKEN`.
2. Start the app.
3. Open the bot in Telegram.
4. Send `/start`.
5. Copy the chat id shown by the bot into `.env`.

## Local Development

Use visible browser mode:

```env
HEADLESS=false
DEBUG=false
```

Run:

```powershell
node src/index.js
```

On Windows, `npm.cmd start` can show `Terminate batch job (Y/N)?` after `Ctrl+C`. That is a Windows batch-wrapper prompt, not an app error. Running `node src/index.js` avoids it.

## Linux Deployment

Install dependencies:

```bash
sudo apt update
sudo apt install -y nodejs npm
npm install
npx playwright install --with-deps chromium
cp .env.example .env
nano .env
```

Use server mode:

```env
HEADLESS=true
DEBUG=false
```

Start directly:

```bash
npm start
```

## PM2 24/7 Deployment

Install PM2:

```bash
sudo npm install -g pm2
```

Start the app:

```bash
npm run pm2:start
pm2 save
pm2 startup
```

Logs:

```bash
npm run pm2:logs
```

Useful PM2 commands:

```bash
npm run pm2:status
npm run pm2:restart
npm run pm2:stop
```

The included [ecosystem.config.js](./ecosystem.config.js) runs one instance, restarts on crashes, and defaults to `HEADLESS=true`.

## Configuration

All configuration is in `.env`.

Important variables:

- `TELEGRAM_BOT_TOKEN` - Telegram Bot API token.
- `TELEGRAM_CHAT_ID` - allowed Telegram chat id.
- `ASPHALT_EMAIL` - Gameloft account email.
- `HEADLESS` - `false` for visible local browser, `true` for server.
- `BROWSER_ENGINE` - `chromium` by default, `firefox` for constrained Linux/proot fallback.
- `DEBUG` - technical stack traces and raw API errors.
- `DATA_DIR` - root storage directory.
- `BROWSER_PROFILE_DIR` - persistent Playwright profile.
- `REWARD_IMAGES_DIR` - local reward images.
- `DEBUG_SNAPSHOTS_DIR` - HTML snapshots for collector debugging.
- `SQLITE_PATH` - SQLite database path.
- `IMAGE_RETENTION_DAYS` - reward image cleanup window.
- `DEBUG_SNAPSHOT_RETENTION_DAYS` - debug snapshot cleanup window.
- `RESTART_NOTIFICATION_TTL_HOURS` - how long the temporary PM2 restart notification stays in Telegram.
- `HEARTBEAT_INTERVAL_HOURS` - how often the app logs and updates the dashboard that it is still running.

## Storage

- Browser profile: `data/browser-profile`
- SQLite database: `data/asphalt.sqlite`
- Reward images: `data/reward-images`
- Debug snapshots: `data/debug-snapshots`

SQLite stores:

- auth state
- dashboard message id
- recent dashboard actions/messages
- scheduler offset and next run
- reward collection history

Runtime files in `data/`:

- `graceful_shutdown.flag` - written on SIGINT/SIGTERM to distinguish graceful stops from crash/reboot restarts.
- `last_successful_collect.timestamp` - used on startup to decide whether immediate auto-collect is needed.
- `restart_notification.json` - stores temporary restart notification metadata.

## OTP Flow

When the dashboard says OTP is expected, send only the 5 digits:

```text
12345
```

The bot deletes the raw OTP message after reading it.

## Scheduler

After a successful collection, the next run is scheduled for:

```text
24 hours + persisted random offset
```

Manual failed collections do not overwrite an existing valid next scheduled run.

After restart, the scheduler restores `nextRunAt` from SQLite. If it is already due, the app schedules the collection shortly after startup.

On startup, if the last successful collect was more than 24 hours and 10 minutes ago, the app starts a collection immediately before the scheduler is initialized. If this startup collection fails, the existing valid schedule is preserved.

Every `HEARTBEAT_INTERVAL_HOURS` hours the app logs and updates the dashboard with a short “program is alive” status and the next scheduled collection time.

## PM2 Restart Notification

When running under PM2, the app detects whether the previous process stopped gracefully:

- graceful shutdown writes `data/graceful_shutdown.flag`;
- missing, invalid, or stale flag is treated as PM2 crash/reboot restart;
- the bot sends a temporary Telegram warning message outside the dashboard;
- the message is deleted after `RESTART_NOTIFICATION_TTL_HOURS` hours.

This restart notification is the only intentional exception to the one-dashboard-message rule.

## Troubleshooting

For a full step-by-step validation flow, see [TESTING.md](./TESTING.md).

Telegram says chat not found:

- open the bot in Telegram;
- send `/start`;
- copy the shown chat id to `TELEGRAM_CHAT_ID`;
- restart the app.

Session lost:

- press `Увійти`;
- wait for OTP email;
- send the 5-digit OTP.

Rewards unavailable:

- this is recorded in the dashboard;
- manual failed attempts do not change the existing schedule.

Parsing or selector issues:

- enable `DEBUG=true`;
- check `data/debug-snapshots`;
- update selectors in `src/automation/selectors.js` if the shop page changed.

## Project Structure

```text
src/
  automation/   Playwright auth, collection and parsing
  bot/          Telegram dashboard and handlers
  scheduler/    24h + offset scheduling
  storage/      SQLite repositories
  status/       status event reporter
  utils/        logging, cleanup, snapshots, time helpers
```

## Safety Notes

Do not commit:

- `.env`
- `data/`
- browser profiles
- reward images
- debug snapshots

These are already covered by `.gitignore`.

## License

MIT
