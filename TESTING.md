# Asphalt Daily Rewards Testing Plan

Цей план потрібен, щоб перевірити програму після фаз стабілізації без хаосу і без зайвого ризику для scheduler.

## 0. Перед стартом

На телефоні/server:

```bash
cd ~/Desktop/AsphaltDailyRewards
git pull
npm install
npx playwright install firefox
npm run check
```

Рекомендований `.env` для visible debug на телефоні:

```env
BROWSER_ENGINE=firefox
HEADLESS=false
DEBUG=true
HEARTBEAT_INTERVAL_HOURS=6
```

Коли visible mode стане стабільним, для 24/7:

```env
BROWSER_ENGINE=firefox
HEADLESS=true
DEBUG=false
HEARTBEAT_INTERVAL_HOURS=6
```

## 1. Static/Syntax Check

Команда:

```bash
npm run check
```

Очікування:

- команда завершується без помилок;
- немає `SyntaxError`;
- немає `Cannot find module`.

Якщо є `Cannot find module`, виконати:

```bash
npm install
```

## 2. Browser Healthcheck

Команда:

```bash
BROWSER_ENGINE=firefox HEADLESS=false DEBUG=true npm run healthcheck
```

Очікування:

- відкривається браузер;
- `about:blank` проходить;
- local HTML render проходить;
- `example.com` проходить;
- Gameloft shop navigation проходить.

Якщо Chromium падає на aarch64/proot Linux, це очікувано для твого середовища. Використовуй Firefox.

## 3. First App Start

Команда для ручного visible test:

```bash
BROWSER_ENGINE=firefox HEADLESS=false DEBUG=true npm start
```

Очікування в консолі:

- `[INFO] Telegram-бот запущено`;
- `[INFO] Наступний збір нагород заплановано на ...`;
- немає fatal startup error.

Очікування в Telegram:

- є один dashboard message;
- кнопки працюють;
- dashboard не дублюється;
- у dashboard видно:
  - `Статус`;
  - `Операція`;
  - `Збір`;
  - `Сесія`;
  - `OTP`;
  - останні дії з `[HH:mm:ss]`;
  - останні повідомлення з `[HH:mm:ss]`.

## 4. PM2 Basic Control

Запуск:

```bash
npm run pm2:start
```

Перевірити статус:

```bash
npm run pm2:status
```

Очікування:

- app name: `asphalt-daily-rewards`;
- status: `online`;
- restarts не росте постійно;
- memory не росте швидко без дій.

Дивитися логи:

```bash
npm run pm2:logs
```

Вийти з логів:

```text
Ctrl+C
```

Це не зупиняє програму, лише закриває перегляд логів.

Зупинити:

```bash
npm run pm2:stop
```

Перезапустити:

```bash
npm run pm2:restart
```

Після стабільного запуску:

```bash
pm2 save
pm2 startup
```

## 5. Dashboard Recovery

У Telegram:

1. Натисни `/start`.
2. Переконайся, що dashboard не створює багато копій.
3. Якщо dashboard виглядає зламаним, виконай:

```text
/dashboard_reset
```

Очікування:

- старе dashboard message видаляється або ігнорується;
- створюється один новий dashboard;
- кнопки працюють.

## 6. Session Check

У Telegram натисни:

```text
Перевірити сесію
```

Очікування, якщо session активна:

- браузер відкриває shop;
- dashboard показує `Сесія активна`;
- браузер закривається після перевірки.

Очікування, якщо session неактивна:

- dashboard показує, що потрібен логін;
- програма не падає.

## 7. Login / OTP Flow

У Telegram натисни:

```text
Увійти
```

Очікування:

- браузер відкривається;
- бот доходить до Gameloft login;
- email вводиться;
- dashboard показує `Очікую OTP-код`;
- raw OTP message у Telegram видаляється після введення.

Надішли OTP просто цифрами:

```text
12345
```

Очікування:

- dashboard показує `OTP отримано`;
- потім `Вхід успішний`;
- session зберігається в `data/browser-profile`;
- після завершення login browser закривається.

Негативний тест:

- коли OTP очікується, надішли неправильний формат, наприклад `abc`;
- dashboard має показати, що OTP має бути 5 цифр;
- програма не падає.

## 8. Manual Collect Before Gifts Are Available

Це можна тестувати вдень, коли gifts ще недоступні.

У Telegram натисни:

```text
Зібрати подарунки
```

Очікування:

- dashboard показує `Collect #N`;
- у логах видно source `manual`;
- видно `Знайшов 0 доступних Free Gift карток` або точнішу причину;
- result: `Подарунки зараз недоступні`;
- existing `nextRunAt` не змінюється;
- у summary є `Графік не змінено`.

Це критично: невдала ручна спроба не повинна збивати нічний timer.

## 9. Manual Collect When Gifts Are Available

Це тестувати тільки коли реально пройшло 24 години і gifts доступні.

У Telegram натисни:

```text
Зібрати подарунки
```

Очікування:

- dashboard показує `Collect #N`;
- лог містить:
  - `Знайшов 1/2 доступних Free Gift карток`;
  - `Обрав подарунок #1: ...`;
  - `Натискаю Claim на checkout сторінці`;
  - `Перший подарунок зібрано`;
  - повернення в магазин;
  - другий подарунок, якщо він доступний.
- reward names мають бути реальними, наприклад:
  - `1x Porsche 919 Street SE Multi I Cardpacks`;
  - `1x HENNESSEY VENOM F5`.

Очікувані результати:

- 2/2: `success`, schedule оновлено;
- 1/2: `partial`, schedule оновлено;
- 0/2: `unavailable`, manual schedule preserved.

## 10. Scheduled Collect Night Test

Перед нічним тестом:

```bash
npm run pm2:status
npm run pm2:logs
```

Очікування:

- PM2 status `online`;
- dashboard показує правильний `Наступний збір`;
- телефон не засинає так, щоб вбити Linux/PM2.

Після нічного часу збору перевірити:

```bash
npm run pm2:logs
```

У логах має бути:

- `Collect #N: Старт збору (scheduled)`;
- browser launch;
- shop open;
- gift discovery count;
- checkout/claim steps;
- final result;
- новий `Наступний збір` через 24h + offset.

У Telegram:

- dashboard оновлений;
- `Останні збори` показує новий run;
- history містить запис;
- reward images є, якщо їх вдалося зберегти.

## 11. Reward Images

Перевірити локально:

```bash
find data/reward-images -type f | tail
```

Очікування:

- після успішного або partial збору є image files;
- Telegram recent collects може показати reward image як dashboard photo у view `Останні збори`.

Cleanup:

- images старше `IMAGE_RETENTION_DAYS` мають видалятись під час collect job.

## 12. Debug Snapshots

Якщо збір падає:

```bash
ls -lah data/debug-snapshots
```

Очікування:

- є `.html` snapshot;
- у логах є шлях до snapshot;
- history/dashboard не показують raw stack у звичайному `DEBUG=false`.

## 13. Restart / Recovery

PM2 restart:

```bash
npm run pm2:restart
```

Очікування:

- app повертається в `online`;
- dashboard recover працює;
- `nextRunAt` читається з SQLite;
- якщо це PM2 crash/reboot detected, приходить тимчасове restart notification.

Graceful stop:

```bash
npm run pm2:stop
```

Очікування:

- browser context закривається;
- процес не лишає zombie browser;
- після start scheduler відновлює next run.

## 14. What To Report If Something Breaks

Найкорисніша інформація для діагностики:

1. Команда запуску.
2. `.env` без токена.
3. Останні 50 рядків:

```bash
npm run pm2:logs -- --lines 50
```

або:

```bash
pm2 logs asphalt-daily-rewards --lines 50
```

4. Точний `Collect #N`.
5. `data/debug-snapshots/...html`, якщо він створився.
6. Скрін браузера, якщо `HEADLESS=false`.

## 15. Go / No-Go Before Leaving It Overnight

Можна лишати на ніч, якщо:

- `npm run check` проходить;
- `healthcheck` проходить на Firefox;
- PM2 status `online`;
- dashboard показує правильний next run;
- session активна або login/OTP пройдений;
- manual unavailable test не змінив графік;
- логи не показують постійні crashes/restarts.

Не лишати на ніч, якщо:

- PM2 `restarts` росте кожні кілька хвилин;
- browser не стартує;
- dashboard не оновлюється;
- SQLite/data directory має permission errors;
- next run показує `unknown`.
