# Project Context

This file is the operational handoff for continuing AsphaltDailyRewards development. Read it together with [README.md](./README.md) and [TESTING.md](./TESTING.md) before making changes.

## Project snapshot

AsphaltDailyRewards is a Node.js Telegram-controlled Playwright automation project for collecting Asphalt Legends daily rewards from the Gameloft shop. The repository is https://github.com/hesher116/AsphaltDailyRewards. The app includes a Telegram dashboard, Gameloft ID OTP login, persistent browser profile, scheduler, SQLite history/state, reward image saving, debug HTML snapshots, PM2 deployment, and Linux/phone-server support. The current runtime target is a constrained Linux environment on a phone where Chromium crashed, but Firefox works, so `BROWSER_ENGINE=firefox` is important there. The user currently runs `HEADLESS=false` intentionally to watch browser actions; later they plan to switch to `HEADLESS=true`. Login/OTP flow works, browser persistence works, manual collection has partially worked, and the system has been progressively hardened. Current readiness: good enough for structured testing, not yet fully production-proven until a successful night scheduled collect is observed.

## Current objective

The active objective is to make the program stable, observable, and maintainable without rewriting the working core. The last completed work focused on stability phases: collect tracing, normalized results, checkout isolation, gift discovery diagnostics, scheduler policy, dashboard UX, cleanup, and a detailed testing checklist. Expected outcome: run the full `TESTING.md` flow on the phone environment, validate PM2 and dashboard behavior, then observe a real scheduled night collect when rewards become available.

## Completed in the latest development session

### Collect job tracing

- Added `Collect #N`, `source`, `jobId`, `collectedCount`, and `expectedCount`.
- Purpose: make logs and dashboard traceable per collection job.
- Files:
  - `src/status/statusReporter.js`
  - `src/scheduler/rewardScheduler.js`
  - `src/automation/asphaltCollector.js`
  - `src/bot/botHandlers.js`
  - `src/index.js`
- Commit: `cce055e Add collect job trace`

### Normalized collect result summaries

- Added `src/automation/collectResult.js`.
- Centralized result normalization, status titles, progress text, and summaries.
- Purpose: avoid ad hoc result formatting in scheduler, bot handlers, and index bootstrap.
- Files:
  - `src/automation/collectResult.js`
  - `src/scheduler/rewardScheduler.js`
  - `src/bot/botHandlers.js`
  - `src/index.js`
  - `package.json`
- Commit: `6d1dd40 Normalize collect result summaries`

### Checkout claim flow extraction

- Added `src/automation/checkoutFlow.js`.
- Moved checkout readiness, mounted React app waiting, cookie notice handling, reward name extraction, Claim click, and success wait into a dedicated module.
- Purpose: keep shop gift discovery separate from checkout/Claim behavior.
- Files:
  - `src/automation/checkoutFlow.js`
  - `src/automation/rewardParser.js`
  - `package.json`
- Commit: `5b603f5 Extract checkout claim flow`

### Free Gift discovery diagnostics

- Strengthened card-container fallback lookup.
- Added status messages for how many available `Free Gift` cards were found and which reward was selected.
- Purpose: diagnose cases where the user sees gifts visually but the bot fails to find them.
- Files:
  - `src/automation/rewardParser.js`
- Commit: `9e60a92 Improve free gift discovery diagnostics`

### Scheduler policy clarity

- Added `src/scheduler/schedulerPolicy.js`.
- Made scheduling decisions explicit:
  - success/partial -> reschedule after success;
  - manual failure -> preserve current schedule;
  - startup failure -> preserve current schedule;
  - scheduled failure -> schedule next cycle.
- Purpose: prevent accidental schedule changes, especially after failed manual collect.
- Files:
  - `src/scheduler/schedulerPolicy.js`
  - `src/scheduler/rewardScheduler.js`
  - `package.json`
- Commit: `4c1172f Clarify scheduler policy decisions`

### Dashboard operation UX

- Dashboard now tracks `currentOperation`.
- Added dashboard fields:
  - `Операція`;
  - `Збір`;
  - timestamped recent actions/messages as `[HH:mm:ss]`.
- Purpose: make Telegram dashboard show what is happening now and what happened recently.
- Files:
  - `src/bot/dashboard.js`
- Commit: `8a469dc Improve dashboard operation status`

### Safe cleanup

- Removed unused code:
  - `nextDailyRunDate`;
  - `addMs`;
  - `randomInt`;
  - `freeRewardLabel`;
  - `editCaption`;
  - legacy `lastAction` / `lastMessage` aliases.
- Purpose: reduce dead code without changing behavior.
- Files:
  - `src/utils/time.js`
  - `src/automation/selectors.js`
  - `src/bot/telegramBot.js`
  - `src/bot/dashboard.js`
- Commit: `ed56c48 Remove unused helper code`

### Production testing checklist

- Added `TESTING.md`.
- Linked it from `README.md`.
- Purpose: provide a detailed validation flow for phone/Linux, PM2, dashboard, OTP, manual collect, scheduled collect, images, snapshots, and go/no-go checks.
- Files:
  - `TESTING.md`
  - `README.md`
- Commit: `02659a2 Add production testing checklist`

## Files changed or discussed

### `src/index.js`

- Bootstraps config, DB, bot, dashboard, scheduler, startup auto-collect, PM2 restart notification, and shutdown handlers.
- Changed to use `collectStatusTitle` and `buildCollectSummary` for scheduled collect notifications.

### `src/config.js`

- Reads `.env`, including browser engine/headless/profile paths/timeouts.
- Important variable for phone Linux: `BROWSER_ENGINE=firefox`.
- Previously includes `HEARTBEAT_INTERVAL_HOURS`.

### `src/automation/asphaltCollector.js`

- Orchestrates one collect job: open shop, ensure session, health check, collect up to 2 rewards.
- Now accepts `job`, emits job-aware trace messages, and returns `jobId`, `source`, `collectedCount`, `expectedCount`.

### `src/automation/rewardParser.js`

- Handles shop-side reward discovery and image saving.
- Checkout logic moved out.
- Now imports `claimReward`, `closeCookieNotice`, and `extractRewardNameFromText` from `checkoutFlow`.
- Includes stronger gift card detection and diagnostic messages.

### `src/automation/checkoutFlow.js`

- Dedicated checkout/Claim/success module.
- Contains:
  - `extractRewardNameFromText`;
  - `closeCookieNotice`;
  - `waitForCheckoutReady`;
  - `claimReward`.

### `src/automation/collectResult.js`

- Normalized result model and user-facing collect summaries.
- Contains:
  - `normalizeCollectResult`;
  - `isCollectSuccess`;
  - `collectStatusTitle`;
  - `buildCollectSummary`;
  - `progressText`;
  - `rewardTextInline`.

### `src/automation/selectors.js`

- Central selector list for login, OTP, order summary, claim button, reward image.
- Removed unused `freeRewardLabel`.

### `src/scheduler/rewardScheduler.js`

- Manages timers, retries, manual/startup/scheduled runs, and schedule persistence.
- Creates collect job IDs.
- Uses `normalizeCollectResult`.
- Uses `decideScheduleAction`.
- Logs schedule decisions.

### `src/scheduler/schedulerPolicy.js`

- Explicit scheduling policy.
- Contains `decideScheduleAction`.

### `src/status/statusReporter.js`

- Emits status events to dashboard and logs.
- Supports contextual prefixing, e.g. `Collect #N: ...`.

### `src/bot/dashboard.js`

- One-message Telegram dashboard state/rendering.
- Tracks current operation and timestamped recent actions/messages.
- Removed old `lastAction` / `lastMessage` aliases.

### `src/bot/botHandlers.js`

- Telegram commands and callback handlers.
- Manual collect uses `buildCollectSummary` and `collectStatusTitle`.

### `src/bot/telegramBot.js`

- Custom Telegram Bot API wrapper.
- Removed unused `editCaption`.
- Important invariant: dashboard should edit one main message and avoid service-message spam, except allowed special notifications.

### `src/utils/time.js`

- Time formatting and delay helpers.
- Removed unused `nextDailyRunDate`, `addMs`, `randomInt`.

### `src/storage/db.js`

- SQLite schema and migrations for session/dashboard state.
- Important for dashboard recent actions/messages and scheduler state persistence.

### `src/storage/rewardsRepository.js`

- Reward run history.
- `getRecentSuccessful(3)` powers the `Останні збори` view.

### `README.md`

- General project usage/deployment documentation.
- Now links to `TESTING.md` and `PROJECT_CONTEXT.md`.

### `TESTING.md`

- Full validation plan for current stabilized version.

## Architecture and invariants

### One-dashboard-message rule

- Telegram UX should use one main dashboard message.
- Dashboard/history/recent collects/status/help should edit the same dashboard message.
- Do not spam new service messages.
- Exception: temporary PM2 restart notification is allowed as a separate message.

### Browser lifecycle

- Browser opens only when needed and closes after action.
- Persistent Playwright profile must remain on disk in `data/browser-profile`.
- Do not close browser while OTP flow is waiting for user input.
- After login/collect/check session, browser should close if idle.

### OTP flow

- If auth state is `waiting_otp`, a plain 5-digit message is treated as OTP.
- Raw OTP message is deleted after reading.
- Invalid OTP format should not crash the flow.
- Successful login must save persistent session.

### Scheduler behavior

- Successful or partial collect updates next run to 24h + persisted random offset.
- Manual unavailable/failure must preserve existing valid schedule.
- Startup auto-collect failure must preserve existing schedule.
- Scheduled failure after retries should schedule next cycle.
- Scheduler must restore `nextRunAt` from SQLite after restart.

### Startup auto-collect

- On startup, if last successful collect is older than 24h10m, app may collect immediately.
- It should not duplicate a near upcoming scheduled run.
- Failure should not destroy existing schedule.

### PM2 restart notification

- Detects non-graceful restart via graceful shutdown flag.
- Sends temporary Telegram warning outside dashboard.
- Deletes notification after TTL.

### Data persistence

- SQLite stores `session_state`, scheduler offset, next run, dashboard message id, recent actions/messages, and reward history.
- Reward images are stored under `data/reward-images` and cleaned by retention.
- Debug snapshots are stored under `data/debug-snapshots` and cleaned by retention.

### Result model

- Use `collectResult.js` for status, progress, titles, and summaries.
- Avoid ad hoc result string formatting in scheduler/bot/index.

### Checkout/gift separation

- `rewardParser.js` handles shop gift discovery and image saving.
- `checkoutFlow.js` handles checkout page, order summary, Claim, and success.

## Known issues and risks

- Real scheduled night collect has not yet been fully validated after the latest phases.
- Rewards can only be collected after 24h, so manual success testing is time-gated.
- Firefox works on the phone Linux environment; Chromium crashed during navigation on aarch64/proot.
- `HEADLESS=false` is intentionally used for visual debugging; final `HEADLESS=true` server behavior still needs validation.
- Gameloft checkout can be slow/blank on weak phone hardware; retry logic exists but still needs real-world proof.
- Gift discovery improved, but real DOM changes can still break selectors.
- Partial success behavior should be observed carefully: it currently counts as success for scheduling.
- Dashboard caption has Telegram length limits; more verbose logs can still truncate.
- PM2 behavior on phone Linux should be tested: status, logs, restart count, startup persistence.
- Need verify dashboard persistence after restart with new `{ text, at }` recent buffers; backward compatibility was implemented.

## Pending tasks

- Run full `TESTING.md` on the phone environment.
  - Direction: `git pull`, `npm install`, `npm run check`, Firefox healthcheck, dashboard test, PM2 test.

- Validate manual unavailable collect.
  - Direction: press `Зібрати подарунки` before rewards are available and confirm schedule is preserved.

- Validate scheduled night collect.
  - Direction: leave app under PM2 until next reward window, inspect logs/dashboard/history/images after scheduled run.

- Validate headless Firefox.
  - Direction: after visible mode works, set `HEADLESS=true`, run healthcheck and one manual unavailable flow.

- Consider next cleanup pass only after runtime validation.
  - Direction: inspect remaining helper functions and UI commands; do not remove anything used in testing.

- Consider error taxonomy phase.
  - Direction: add explicit error codes like `CHECKOUT_NOT_READY`, `CLAIM_NOT_FOUND`, `SHOP_SELECTOR_CHANGED`.

- Consider PM2/runtime status view.
  - Direction: dashboard button/view for uptime, next run, last error. Requires care because app may not directly know PM2 details.

- Consider selector diagnostics command.
  - Direction: add safe check that opens shop and reports whether Daily Gift section, Free buttons, and Claim selectors are visible.

## How to continue

1. Pull latest repo and inspect current state:

   ```bash
   git pull
   git log --oneline -10
   npm run check
   ```

2. Read key files first:
   - `TESTING.md`
   - `src/automation/rewardParser.js`
   - `src/automation/checkoutFlow.js`
   - `src/scheduler/rewardScheduler.js`
   - `src/scheduler/schedulerPolicy.js`
   - `src/bot/dashboard.js`

3. Ask/check whether phone tests were run and collect logs/results.

4. If tests were not run, follow `TESTING.md`.

5. If coding continues before night collect, prefer low-risk work:
   - docs;
   - diagnostics;
   - error taxonomy;
   - dashboard display.

Avoid changing checkout/gift click behavior unless logs show a concrete issue.

## Session changelog

### Date

2026-05-07

### Session goal

Harden AsphaltDailyRewards without rewriting core behavior, using small safe phases. Improve observability, result consistency, checkout separation, gift discovery diagnostics, scheduler policy clarity, dashboard UX, cleanup, and testing documentation.

### Completed

- Added collect job tracing:
  - `Collect #N`, `source`, `jobId`, `collectedCount`, `expectedCount`.
  - Files: `src/status/statusReporter.js`, `src/scheduler/rewardScheduler.js`, `src/automation/asphaltCollector.js`, `src/bot/botHandlers.js`, `src/index.js`.
  - Commit: `cce055e Add collect job trace`.

- Added normalized collect result model:
  - New `src/automation/collectResult.js`.
  - Centralized result normalization, status titles, progress, summaries.
  - Files: `src/automation/collectResult.js`, `src/scheduler/rewardScheduler.js`, `src/bot/botHandlers.js`, `src/index.js`, `package.json`.
  - Commit: `6d1dd40 Normalize collect result summaries`.

- Extracted checkout claim flow:
  - New `src/automation/checkoutFlow.js`.
  - Moved checkout readiness, React app wait, reward name extraction, Claim click, success wait.
  - Files: `src/automation/checkoutFlow.js`, `src/automation/rewardParser.js`, `package.json`.
  - Commit: `5b603f5 Extract checkout claim flow`.

- Improved Free Gift discovery diagnostics:
  - Added card-container fallback lookup.
  - Added logs for found Free Gift count and selected reward.
  - Files: `src/automation/rewardParser.js`.
  - Commit: `9e60a92 Improve free gift discovery diagnostics`.

- Clarified scheduler policy:
  - New `src/scheduler/schedulerPolicy.js`.
  - Explicit decisions for success, manual failure, startup failure, scheduled failure.
  - Files: `src/scheduler/schedulerPolicy.js`, `src/scheduler/rewardScheduler.js`, `package.json`.
  - Commit: `4c1172f Clarify scheduler policy decisions`.

- Improved dashboard operation status:
  - Added current operation and collect running state.
  - Recent actions/messages now store `{ text, at }` and render `[HH:mm:ss]`.
  - Files: `src/bot/dashboard.js`.
  - Commit: `8a469dc Improve dashboard operation status`.

- Removed unused helper code:
  - Removed `nextDailyRunDate`, `addMs`, `randomInt`, `freeRewardLabel`, `editCaption`, legacy `lastAction/lastMessage`.
  - Files: `src/utils/time.js`, `src/automation/selectors.js`, `src/bot/telegramBot.js`, `src/bot/dashboard.js`.
  - Commit: `ed56c48 Remove unused helper code`.

- Added detailed testing checklist:
  - New `TESTING.md`.
  - README links to it.
  - Files: `TESTING.md`, `README.md`.
  - Commit: `02659a2 Add production testing checklist`.

### Decisions

- Continue using Firefox on the phone Linux environment because Chromium crashed on aarch64/proot navigation.
- Keep `HEADLESS=false` during visual debugging; switch to `HEADLESS=true` only after stable visible tests.
- Do not change core click/checkout behavior unless logs show a specific failure.
- Keep manual unavailable/failure from changing existing valid schedule.
- Treat partial collect as successful enough to update schedule.
- Keep one-dashboard-message Telegram UX; only PM2 restart notification is allowed as separate temporary message.
- Separate responsibilities:
  - `rewardParser.js` for shop/gift discovery.
  - `checkoutFlow.js` for checkout/Claim/success.
  - `collectResult.js` for status/result text.
  - `schedulerPolicy.js` for scheduling decisions.

### Files touched

- `src/index.js`
- `src/status/statusReporter.js`
- `src/scheduler/rewardScheduler.js`
- `src/scheduler/schedulerPolicy.js`
- `src/automation/asphaltCollector.js`
- `src/automation/rewardParser.js`
- `src/automation/checkoutFlow.js`
- `src/automation/collectResult.js`
- `src/automation/selectors.js`
- `src/bot/dashboard.js`
- `src/bot/botHandlers.js`
- `src/bot/telegramBot.js`
- `src/utils/time.js`
- `package.json`
- `README.md`
- `TESTING.md`

### Next steps

- Run `TESTING.md` on the phone environment.
- Validate `npm run check`, Firefox healthcheck, dashboard recovery, PM2 status/logs.
- Validate manual unavailable collect and confirm schedule preservation.
- Wait for real reward availability and validate scheduled night collect.
- After runtime validation, consider:
  - error taxonomy;
  - selector diagnostics command;
  - PM2/runtime status view;
  - further safe cleanup.

### Risks / notes

- Real scheduled collect after latest refactors has not yet been observed.
- Rewards are time-gated; success path can only be tested when gifts are available.
- Checkout can be slow/blank on phone hardware.
- Telegram dashboard caption length can truncate verbose state.
- Dashboard recent buffers now store objects but support old string arrays.
- Do not refactor browser click flow further before seeing test results.
