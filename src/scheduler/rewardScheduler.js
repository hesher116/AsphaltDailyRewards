const config = require('../config');
const logger = require('../utils/logger');
const { delay, nowIso, formatDateTime, formatDateTimeForLog, nextDailyTimeInAppZone, timeZoneName } = require('../utils/time');
const { removeOldFiles } = require('../utils/fileCleanup');
const { savePageSnapshot } = require('../utils/debugSnapshot');
const { safeWriteLastCollect, writeAppHeartbeat } = require('../utils/runtimeState');
const { isVerifiedCollect, normalizeCollectResult } = require('../automation/collectResult');
const { decideScheduleAction } = require('./schedulerPolicy');

function randomOffsetMs() {
  const min = config.scheduler.minJitterMs;
  const max = config.scheduler.maxJitterMs;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomRetryDelayMs() {
  const min = Math.max(1000, config.runtime.rewardRetryMinDelayMs);
  const max = Math.max(min, config.runtime.rewardRetryMaxDelayMs);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function collectErrorForUser(error) {
  const raw = String(error && error.message ? error.message : error || '').trim();
  const firstLine = raw.split('\n').find(Boolean) || 'невідома помилка';
  const lower = raw.toLowerCase();

  if (lower.includes('executable doesn') || lower.includes('browser executable')) {
    return 'Chromium не встановлено для Playwright. Запусти: npx playwright install chromium';
  }

  if (lower.includes('host system is missing dependencies') || lower.includes('missing dependencies')) {
    return 'У Linux бракує системних залежностей Chromium. Спробуй: npx playwright install --with-deps chromium';
  }

  if (lower.includes('timeout')) {
    return 'сайт або потрібний елемент не відповів вчасно';
  }

  if (lower.includes('net::') || lower.includes('err_name_not_resolved') || lower.includes('err_connection')) {
    return 'не вдалося відкрити сайт, перевір інтернет або доступ до Gameloft';
  }

  if (lower.includes('target page') || lower.includes('context or browser has been closed')) {
    return 'браузер закрився під час збору';
  }

  return firstLine.length > 220 ? `${firstLine.slice(0, 217)}...` : firstLine;
}

function rewardSignature(runOrResult) {
  return (runOrResult && runOrResult.rewards ? runOrResult.rewards : [])
    .map((reward) => String(reward.name || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' | ');
}

function rewardNames(runOrResult) {
  return (runOrResult && runOrResult.rewards ? runOrResult.rewards : [])
    .map((reward) => reward.name)
    .filter(Boolean)
    .join(', ');
}

function expectedBaselineFromRun(run) {
  if (!run) return 0;
  return Number(run.expectedCount || 0) || Number(run.collectedCount || 0) || (run.rewards || []).length || 0;
}

function progressLine(run) {
  if (!run) return 'no runs yet';
  const expected = Number(run.expectedCount || 0);
  const collected = Number(run.collectedCount || 0);
  if (expected <= 0 && run.status === 'unavailable') {
    return '0 available; no claim attempt';
  }
  return `${collected}/${expected}`;
}

function findLastVerifiedRun(rewardsRepository) {
  return rewardsRepository.getRecent(20).find((run) => isVerifiedCollect(run.status)) || null;
}

function nextUtcDailyCheckDate(now = new Date()) {
  const hour = Math.min(23, Math.max(0, config.runtime.dailyShopCheckUtcHour));
  const minute = Math.min(59, Math.max(0, config.runtime.dailyShopCheckUtcMinute));
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
    0,
    0
  ));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function sourceLabel(source) {
  if (source === 'daily_store_check') return 'daily_store_check';
  if (source === 'daily_check') return 'daily_store_check';
  if (source === 'scheduled_collect') return 'scheduled_collect';
  if (source === 'scheduled') return 'scheduled_collect';
  if (source === 'retry_collect') return 'retry_collect';
  if (source === 'startup_collect') return 'startup_collect';
  if (source === 'startup') return 'startup_collect';
  if (source === 'manual_collect') return 'manual_collect';
  if (source === 'manual') return 'manual_collect';
  return source || 'collect';
}

function recoveryText(recovery) {
  if (!recovery || !recovery.attempted) return 'not attempted';
  const parts = [`attempted: yes`, `result: ${recovery.result || 'unknown'}`];
  if (recovery.retried) parts.push('collect retried: yes');
  if (recovery.error) parts.push(`error: ${recovery.error}`);
  return parts.join(', ');
}

function shouldAlertFailure(result, source) {
  const normalizedSource = sourceLabel(source);
  if (normalizedSource === 'manual_collect') return false;
  if (isVerifiedCollect(result.status)) return false;
  if (result.status === 'already_running') return false;
  if (normalizedSource === 'daily_store_check' && result.status === 'unavailable') return false;
  return Number(result.expectedCount || 0) > Number(result.collectedCount || 0)
    || ['session_lost', 'error', 'partial', 'unavailable'].includes(result.status);
}

function buildFailureAlert(result) {
  const when = result.createdAt || result.verifiedAt || nowIso();
  return [
    'Щось пішло не так: подарунки не були зібрані, потрібна перевірка.',
    `Time: ${formatDateTime(when)}`,
    `Job type: ${sourceLabel(result.source)}`,
    `Job: ${result.jobLabel || sourceLabel(result.source)}`,
    `Progress: ${result.collectedCount}/${result.expectedCount}`,
    `Status: ${result.status}`,
    `Reason: ${result.error || result.description || result.technicalStatus || 'unknown'}`,
    `Auto recovery: ${recoveryText(result.autoRecovery)}`,
    `Next run: ${formatDateTime(result.nextRunAt)}`
  ].join('\n');
}

class RewardScheduler {
  constructor({ collector, rewardsRepository, sessionRepository, notify }) {
    this.collector = collector;
    this.rewardsRepository = rewardsRepository;
    this.sessionRepository = sessionRepository;
    this.notify = notify;
    this.timer = null;
    this.heartbeatTimer = null;
    this.dailyAuditTimer = null;
    this.dailyAuditNextAt = null;
    this.dailyShopCheckTimer = null;
    this.dailyShopCheckNextAt = null;
    this.shortRetryNextAt = null;
    this.collectRunning = false;
    this.stopped = false;
  }

  isRunning() {
    return this.collectRunning;
  }

  createCollectJob(source, details = {}) {
    const lastRun = this.rewardsRepository.getLast();
    const id = (lastRun ? lastRun.id : 0) + 1;
    const startedAt = nowIso();
    const normalizedSource = sourceLabel(source);
    const retrySuffix = normalizedSource === 'retry_collect' && details.retryAttempt
      ? ` attempt ${details.retryAttempt}/${details.retryMax || config.runtime.rewardRetryCount}`
      : '';
    return {
      id,
      startedAt,
      source: normalizedSource,
      retryAttempt: details.retryAttempt || null,
      retryMax: details.retryMax || null,
      parentJobId: details.parentJobId || null,
      label: `${normalizedSource}${retrySuffix} ${formatDateTimeForLog(startedAt)}`
    };
  }

  start() {
    this.scheduleAt(this.resolveStartupNextRun(this.sessionRepository.getState()));
    this.startHeartbeat();
    this.startDailyAudit();
    this.startDailyShopCheck();
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.dailyAuditTimer) {
      clearTimeout(this.dailyAuditTimer);
      this.dailyAuditTimer = null;
    }
    if (this.dailyShopCheckTimer) {
      clearTimeout(this.dailyShopCheckTimer);
      this.dailyShopCheckTimer = null;
    }
  }

  startHeartbeat() {
    const intervalMs = Math.max(1, config.runtime.heartbeatIntervalHours) * 60 * 60 * 1000;
    const tick = async () => {
      if (this.stopped) return;
      await writeAppHeartbeat('scheduler_heartbeat').catch((error) => {
        logger.debug({ error }, 'Failed to write app heartbeat');
      });
      const state = this.sessionRepository.getState();
      const text = `Програма працює. Наступний збір: ${formatDateTimeForLog(state.nextRunAt)}`;
      logger.info(text);
      if (this.notify) {
        await this.notify({ type: 'heartbeat', text }).catch((error) => {
          logger.debug({ error }, 'Heartbeat notification failed');
        });
      }
      this.heartbeatTimer = setTimeout(tick, intervalMs);
    };

    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    writeAppHeartbeat('scheduler_start').catch((error) => {
      logger.debug({ error }, 'Failed to write app heartbeat');
    });
    this.heartbeatTimer = setTimeout(tick, intervalMs);
  }

  startDailyAudit() {
    const scheduleNext = () => {
      if (this.stopped) return;
      const next = nextDailyTimeInAppZone(config.runtime.dailyAuditHour, config.runtime.dailyAuditMinute);
      this.dailyAuditNextAt = next.toISOString();
      const delayMs = Math.max(config.scheduler.startupDelayMs, next.getTime() - Date.now());
      logger.info(`Daily audit scheduled for ${formatDateTimeForLog(next)} (${timeZoneName()})`);
      if (this.dailyAuditTimer) clearTimeout(this.dailyAuditTimer);
      this.dailyAuditTimer = setTimeout(async () => {
        if (this.stopped) return;
        try {
          const audit = this.buildAuditSnapshot();
          logger.info(`Daily audit: ${audit.text.replace(/\n/g, ' | ')}`);
          if (this.notify) {
            await this.notify({ type: 'daily_audit', audit }).catch((error) => {
              logger.debug({ error }, 'Daily audit notification failed');
            });
          }
        } finally {
          scheduleNext();
        }
      }, delayMs);
    };

    scheduleNext();
  }

  startDailyShopCheck() {
    if (!config.runtime.dailyShopCheckEnabled) return;

    const scheduleNext = () => {
      if (this.stopped) return;
      const next = nextUtcDailyCheckDate();
      this.dailyShopCheckNextAt = next.toISOString();
      const delayMs = Math.max(config.scheduler.startupDelayMs, next.getTime() - Date.now());
      logger.info(`Daily shop check scheduled for ${formatDateTimeForLog(next)} (UTC ${String(config.runtime.dailyShopCheckUtcHour).padStart(2, '0')}:${String(config.runtime.dailyShopCheckUtcMinute).padStart(2, '0')})`);
      if (this.dailyShopCheckTimer) clearTimeout(this.dailyShopCheckTimer);
      this.dailyShopCheckTimer = setTimeout(async () => {
        if (this.stopped) return;
        try {
          await this.runDailyShopCheck();
        } catch (error) {
          logger.error('Daily shop check failed outside normal result flow');
          logger.debug({ error }, 'Daily shop check failed');
        } finally {
          scheduleNext();
        }
      }, delayMs);
    };

    scheduleNext();
  }

  buildAuditSnapshot() {
    const state = this.sessionRepository.getState();
    const lastRun = this.rewardsRepository.getLast();
    const lastVerifiedRun = findLastVerifiedRun(this.rewardsRepository);
    const expectedBaseline = expectedBaselineFromRun(lastVerifiedRun);
    const lastRunSource = lastRun && lastRun.verification ? sourceLabel(lastRun.verification.source || lastRun.source) : 'unknown';
    const lastProblem = lastRun && !isVerifiedCollect(lastRun.status)
      ? `${lastRun.status}: ${lastRun.error || lastRun.description || lastRun.technicalStatus || 'unknown'}`
      : 'none';
    const text = [
      'Daily audit',
      `Last job: ${lastRun ? `${lastRunSource} ${lastRun.status}` : 'no runs yet'}`,
      `Last job time: ${lastRun ? formatDateTimeForLog(lastRun.createdAt) : 'unknown'}`,
      `Last job progress: ${progressLine(lastRun)}`,
      `Last verified collect: ${lastVerifiedRun ? `${formatDateTimeForLog(lastVerifiedRun.verifiedAt || lastVerifiedRun.createdAt)} ${lastVerifiedRun.collectedCount}/${lastVerifiedRun.expectedCount}` : 'unknown'}`,
      `Expected baseline: ${expectedBaseline || 'unknown'}`,
      `Last problem: ${lastProblem}`,
      `Main next collect: ${formatDateTimeForLog(state.nextRunAt)}`,
      `Short retry: ${this.shortRetryNextAt ? formatDateTimeForLog(this.shortRetryNextAt) : 'none'}`,
      `Daily store check: ${this.dailyShopCheckNextAt ? formatDateTimeForLog(this.dailyShopCheckNextAt) : 'unknown'}`,
      `Next audit: ${this.dailyAuditNextAt ? formatDateTimeForLog(this.dailyAuditNextAt) : 'unknown'}`,
      `Auth: ${state.authStatus}`,
      `Collect running: ${this.collectRunning ? 'yes' : 'no'}`
    ].join('\n');
    return { text, state, lastRun };
  }

  resolveStartupNextRun(state) {
    if (state.nextRunAt) {
      const persisted = new Date(state.nextRunAt);
      if (!Number.isNaN(persisted.getTime())) {
        if (persisted.getTime() <= Date.now()) {
          logger.info('Час планового збору вже настав, запускаю найближчим часом');
          return new Date(Date.now() + config.scheduler.startupDelayMs);
        }
        return persisted;
      }
    }

    if (state.lastSuccessfulCollectAt) {
      return this.computeNextFrom(new Date(state.lastSuccessfulCollectAt), state);
    }

    return new Date(Date.now() + config.scheduler.startupDelayMs);
  }

  getOrCreateOffset(state = this.sessionRepository.getState()) {
    if (state.schedulerOffsetMs && state.schedulerOffsetMs > 0) return state.schedulerOffsetMs;
    const offset = randomOffsetMs();
    this.sessionRepository.update({ schedulerOffsetMs: offset });
    return offset;
  }

  computeNextFrom(baseDate, state = this.sessionRepository.getState()) {
    const offset = this.getOrCreateOffset(state);
    const baseTime = Number.isNaN(baseDate.getTime()) ? Date.now() : baseDate.getTime();
    return new Date(baseTime + config.scheduler.baseDelayMs + offset);
  }

  scheduleAt(date) {
    if (this.stopped) return;
    const now = Date.now();
    const safeDate = Number.isNaN(date.getTime()) ? new Date(now + config.scheduler.startupDelayMs) : date;
    const delayMs = Math.max(config.scheduler.startupDelayMs, safeDate.getTime() - now);
    const actualDate = new Date(now + delayMs);

    this.sessionRepository.update({ nextRunAt: actualDate.toISOString() });
    logger.info(`Наступний збір нагород заплановано на ${formatDateTimeForLog(actualDate)}`);

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.runScheduledCollect().catch((error) => {
        logger.error('Плановий збір завершився помилкою');
        logger.debug({ error }, 'Scheduled collect failed outside normal result flow');
      });
    }, delayMs);
  }

  scheduleNextAfterSuccess(result = {}) {
    const verifiedAt = new Date(result.verifiedAt || nowIso());
    const safeVerifiedAt = Number.isNaN(verifiedAt.getTime()) ? new Date() : verifiedAt;
    const offset = randomOffsetMs();
    const nextRunAt = new Date(safeVerifiedAt.getTime() + config.scheduler.baseDelayMs + offset);
    this.sessionRepository.update({
      lastRunAt: nowIso(),
      lastSuccessfulCollectAt: safeVerifiedAt.toISOString(),
      schedulerOffsetMs: offset,
      nextRunAt: nextRunAt.toISOString()
    });
    this.scheduleAt(nextRunAt);
    return nextRunAt.toISOString();
  }

  preserveExistingSchedule() {
    const state = this.sessionRepository.getState();
    if (state.nextRunAt && !Number.isNaN(new Date(state.nextRunAt).getTime())) {
      return state.nextRunAt;
    }
    const nextRunAt = this.resolveStartupNextRun(state);
    this.scheduleAt(nextRunAt);
    return nextRunAt.toISOString();
  }

  async runManualCollect() {
    return this.runCollect({ notify: false, allowRetries: false, source: 'manual_collect' });
  }

  async runStartupCollect() {
    return this.runCollect({ notify: false, allowRetries: false, source: 'startup_collect' });
  }

  async runScheduledCollect() {
    return this.runCollect({ notify: true, allowRetries: true, source: 'scheduled_collect' });
  }

  async runDailyShopCheck() {
    if (this.collectRunning) {
      const text = 'Daily shop check skipped: another collect is already running';
      logger.warn(text);
      if (this.notify) await this.notify({ type: 'info', text }).catch(() => {});
      return { status: 'already_running' };
    }
    return this.runCollect({ notify: true, allowRetries: false, source: 'daily_store_check' });
  }

  getDailyShopCheckNextAt() {
    return this.dailyShopCheckNextAt;
  }

  getDailyAuditNextAt() {
    return this.dailyAuditNextAt;
  }

  getShortRetryNextAt() {
    return this.shortRetryNextAt;
  }

  async runCollect({ notify, allowRetries, source, retryAttempt = null, retryMax = null, parentJobId = null }) {
    if (this.collectRunning) return { status: 'already_running' };

    this.collectRunning = true;
    let finalResult;
    const job = this.createCollectJob(source, { retryAttempt, retryMax, parentJobId });

    try {
      if (this.collector.statusReporter) {
        this.collector.statusReporter.setContext(job);
      }
      logger.debug({ job }, 'Starting reward collection job');
      this.collector.report(`Старт збору (${source})`);
      await removeOldFiles(config.storage.rewardImagesDir, config.storage.imageRetentionDays);
      await removeOldFiles(config.storage.debugSnapshotsDir, config.storage.debugSnapshotRetentionDays);
      finalResult = await this.collector.collect(job);

      if (allowRetries && finalResult.status === 'unavailable') {
        for (let attempt = 1; attempt <= config.runtime.rewardRetryCount; attempt += 1) {
          const retryDelayMs = randomRetryDelayMs();
          const retryAt = new Date(Date.now() + retryDelayMs);
          this.shortRetryNextAt = retryAt.toISOString();
          const text = `${job.label}: Подарунки ще недоступні. retry_collect ${attempt}/${config.runtime.rewardRetryCount} заплановано на ${formatDateTimeForLog(retryAt)}.`;
          logger.warn(text);
          if (this.notify) await this.notify({ type: 'info', text });
          await delay(retryDelayMs);
          const retryJob = this.createCollectJob('retry_collect', {
            retryAttempt: attempt,
            retryMax: config.runtime.rewardRetryCount,
            parentJobId: job.id
          });
          if (this.collector.statusReporter) {
            this.collector.statusReporter.setContext(retryJob);
          }
          logger.debug({ retryJob }, 'Starting reward retry collection job');
          this.collector.report(`Старт повторної спроби (${retryJob.source})`);
          finalResult = await this.collector.collect(retryJob);
          if (finalResult.status !== 'unavailable') break;
        }
        this.shortRetryNextAt = null;
      }

      if (allowRetries && finalResult.status === 'session_lost') {
        finalResult = await this.trySessionRecoveryAndRetry(job, finalResult);
      }
    } catch (error) {
      const userError = collectErrorForUser(error);
      logger.error(`Не вдалося зібрати подарунки: ${userError}`);
      logger.debug({ error }, 'Reward collection crashed');
      const snapshotPath = await savePageSnapshot(this.collector.authFlow.page, 'collector-error');
      if (snapshotPath) {
        logger.warn(`Збережено debug snapshot сторінки: ${snapshotPath}`);
      }
      finalResult = {
        status: 'error',
        rewards: [],
        imagePaths: [],
        description: 'Reward collection failed',
        error: userError,
        technicalStatus: 'collector_error',
        jobId: job.id,
        jobLabel: job.label,
        source
      };
    } finally {
      if (this.collector.statusReporter) {
        this.collector.statusReporter.clearContext();
      }
      this.collectRunning = false;
      await this.collector.authFlow.closeIfIdle();
    }

    finalResult = normalizeCollectResult(finalResult, { job, source });
    const previousVerifiedRun = findLastVerifiedRun(this.rewardsRepository);
    if (
      finalResult.status === 'unavailable' &&
      Number(finalResult.expectedCount || 0) === 0 &&
      ['scheduled_collect', 'retry_collect'].includes(sourceLabel(finalResult.source || source))
    ) {
      const expectedBaseline = expectedBaselineFromRun(previousVerifiedRun);
      if (expectedBaseline > 0) {
        finalResult.expectedCount = expectedBaseline;
        finalResult.description = `No available rewards found; expected baseline ${expectedBaseline} from last verified collect`;
        finalResult.technicalStatus = [finalResult.technicalStatus, `expected_baseline ${expectedBaseline}`].filter(Boolean).join('; ');
      }
    }
    const previousSignature = rewardSignature(previousVerifiedRun);
    const currentSignature = rewardSignature(finalResult);
    if (previousSignature && currentSignature && previousSignature !== currentSignature) {
      const changeText = `Reward set changed: ${rewardNames(previousVerifiedRun)} -> ${rewardNames(finalResult)}`;
      logger.warn(changeText);
      this.collector.report(changeText, 'warn');
      finalResult.technicalStatus = [finalResult.technicalStatus, 'reward_set_changed'].filter(Boolean).join('; ');
    }
    const scheduleDecision = decideScheduleAction({ result: finalResult, source });
    const now = nowIso();
    let nextRunAt;

    if (scheduleDecision.action === 'reschedule_after_success') {
      nextRunAt = this.scheduleNextAfterSuccess(finalResult);
      await safeWriteLastCollect(finalResult.verifiedAt || new Date().toISOString());
      logger.info(`${job.label}: ${scheduleDecision.message}`);
    } else if (scheduleDecision.action === 'preserve_manual_failure') {
      nextRunAt = this.preserveExistingSchedule();
      this.sessionRepository.update({ lastRunAt: now });
      logger.warn(`${job.label}: ${scheduleDecision.message}. Наступний збір: ${formatDateTimeForLog(nextRunAt)}`);
      if (finalResult.status === 'unavailable') {
        logger.warn(`Подарунки зараз недоступні. Наступний збір уже запланований на ${formatDateTimeForLog(nextRunAt)}`);
      }
    } else if (scheduleDecision.action === 'preserve_startup_failure') {
      nextRunAt = this.preserveExistingSchedule();
      this.sessionRepository.update({ lastRunAt: now });
      logger.warn(`${job.label}: ${scheduleDecision.message}. Наступний збір: ${formatDateTimeForLog(nextRunAt)}`);
    } else if (scheduleDecision.action === 'preserve_daily_check_failure') {
      nextRunAt = this.preserveExistingSchedule();
      this.sessionRepository.update({ lastRunAt: now });
      logger.warn(`${job.label}: ${scheduleDecision.message}. Наступний збір: ${formatDateTimeForLog(nextRunAt)}`);
    } else {
      const nextDate = this.computeNextFrom(new Date());
      nextRunAt = nextDate.toISOString();
      this.sessionRepository.update({ lastRunAt: now, nextRunAt });
      this.scheduleAt(nextDate);
      logger.warn(`${job.label}: ${scheduleDecision.message}. Наступний збір: ${formatDateTimeForLog(nextRunAt)}`);
    }

    if (finalResult.status === 'session_lost') {
      this.sessionRepository.update({ authStatus: 'session_lost' });
    }

    const run = this.rewardsRepository.addRun({
      status: finalResult.status,
      rewards: finalResult.rewards,
      imagePaths: finalResult.imagePaths,
      description: finalResult.description,
      error: finalResult.error,
      technicalStatus: finalResult.technicalStatus,
      verifiedAt: finalResult.verifiedAt,
      collectedCount: finalResult.collectedCount,
      expectedCount: finalResult.expectedCount,
      verification: {
        source,
        jobLabel: job.label,
        scheduleAction: scheduleDecision.action,
        scheduleChanged: scheduleDecision.scheduleChanged,
        schedulePreserved: scheduleDecision.schedulePreserved,
        autoRecovery: finalResult.autoRecovery,
        transitions: finalResult.rewards.map((reward) => ({
          name: reward.name,
          availableBefore: reward.availableBefore,
          availableAfter: reward.availableAfter,
          verifiedAt: reward.verifiedAt
        }))
      }
    });

    const resultWithSchedule = {
      ...normalizeCollectResult(finalResult, {
        job,
        source,
        nextRunAt,
        scheduleChanged: scheduleDecision.scheduleChanged,
        schedulePreserved: scheduleDecision.schedulePreserved
      }),
      id: run.id,
      createdAt: run.createdAt,
      nextRunAt
    };

    if (notify && this.notify) {
      await this.notify({ type: 'collect_result', result: resultWithSchedule });
      if (shouldAlertFailure(resultWithSchedule, source)) {
        await this.notify({
          type: 'collect_failure_alert',
          result: resultWithSchedule,
          text: buildFailureAlert(resultWithSchedule)
        });
      }
    }

    return resultWithSchedule;
  }

  async trySessionRecoveryAndRetry(job, failedResult) {
    const recovery = {
      attempted: true,
      startedAt: nowIso(),
      result: 'unknown',
      retried: false,
      error: null
    };

    logger.warn(`${job.label}: session lost, trying one automatic login recovery`);
    this.collector.report('Сесія втрачена, пробую автоматичне відновлення один раз', 'warn');

    try {
      await this.collector.authFlow.close();
      const loginResult = await this.collector.authFlow.startLogin();
      recovery.result = loginResult.status;

      if (loginResult.status === 'already_logged_in') {
        recovery.retried = true;
        const retryResult = await this.collector.collect({
          ...job,
          recoveryAttempt: true
        });
        return {
          ...retryResult,
          autoRecovery: {
            ...recovery,
            finishedAt: nowIso()
          }
        };
      }

      if (loginResult.status === 'need_otp') {
        recovery.error = 'OTP required to finish automatic login';
        return {
          ...failedResult,
          error: 'Session lost; automatic login requested OTP',
          description: 'Session lost and automatic recovery needs OTP',
          autoRecovery: {
            ...recovery,
            finishedAt: nowIso()
          }
        };
      }

      recovery.error = `Unexpected login result: ${loginResult.status}`;
    } catch (error) {
      recovery.result = 'failed';
      recovery.error = collectErrorForUser(error);
      logger.warn(`${job.label}: automatic session recovery failed: ${recovery.error}`);
      logger.debug({ error }, 'Automatic session recovery failed');
    }

    return {
      ...failedResult,
      autoRecovery: {
        ...recovery,
        finishedAt: nowIso()
      }
    };
  }
}

module.exports = RewardScheduler;
