const config = require('../config');
const logger = require('../utils/logger');
const { delay, nowIso, formatDateTimeForLog } = require('../utils/time');
const { removeOldFiles } = require('../utils/fileCleanup');
const { savePageSnapshot } = require('../utils/debugSnapshot');
const { safeWriteLastCollect } = require('../utils/runtimeState');
const { normalizeCollectResult } = require('../automation/collectResult');
const { decideScheduleAction } = require('./schedulerPolicy');

function randomOffsetMs() {
  const min = config.scheduler.minJitterMs;
  const max = config.scheduler.maxJitterMs;
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

class RewardScheduler {
  constructor({ collector, rewardsRepository, sessionRepository, notify }) {
    this.collector = collector;
    this.rewardsRepository = rewardsRepository;
    this.sessionRepository = sessionRepository;
    this.notify = notify;
    this.timer = null;
    this.heartbeatTimer = null;
    this.dailyAuditTimer = null;
    this.collectRunning = false;
    this.stopped = false;
  }

  isRunning() {
    return this.collectRunning;
  }

  createCollectJob(source) {
    const lastRun = this.rewardsRepository.getLast();
    const id = (lastRun ? lastRun.id : 0) + 1;
    const startedAt = nowIso();
    return {
      id,
      startedAt,
      source,
      label: `Collect ${formatDateTimeForLog(startedAt)}`
    };
  }

  start() {
    this.scheduleAt(this.resolveStartupNextRun(this.sessionRepository.getState()));
    this.startHeartbeat();
    this.startDailyAudit();
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
  }

  startHeartbeat() {
    const intervalMs = Math.max(1, config.runtime.heartbeatIntervalHours) * 60 * 60 * 1000;
    const tick = async () => {
      if (this.stopped) return;
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
    this.heartbeatTimer = setTimeout(tick, intervalMs);
  }

  startDailyAudit() {
    const intervalMs = Math.max(1, config.runtime.dailyAuditIntervalHours) * 60 * 60 * 1000;
    const tick = async () => {
      if (this.stopped) return;
      const audit = this.buildAuditSnapshot();
      logger.info(`Daily audit: ${audit.text.replace(/\n/g, ' | ')}`);
      if (this.notify) {
        await this.notify({ type: 'daily_audit', audit }).catch((error) => {
          logger.debug({ error }, 'Daily audit notification failed');
        });
      }
      this.dailyAuditTimer = setTimeout(tick, intervalMs);
    };

    if (this.dailyAuditTimer) clearTimeout(this.dailyAuditTimer);
    this.dailyAuditTimer = setTimeout(tick, intervalMs);
  }

  buildAuditSnapshot() {
    const state = this.sessionRepository.getState();
    const lastRun = this.rewardsRepository.getLast();
    const text = [
      'Daily audit',
      `Status: ${lastRun ? lastRun.status : 'no runs yet'}`,
      `Last run: ${lastRun ? formatDateTimeForLog(lastRun.createdAt) : 'unknown'}`,
      `Verified: ${lastRun && lastRun.verifiedAt ? formatDateTimeForLog(lastRun.verifiedAt) : 'unknown'}`,
      `Progress: ${lastRun ? `${lastRun.collectedCount}/${lastRun.expectedCount}` : '0/0'}`,
      `Next run: ${formatDateTimeForLog(state.nextRunAt)}`,
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
    return this.runCollect({ notify: false, allowRetries: false, source: 'manual' });
  }

  async runStartupCollect() {
    return this.runCollect({ notify: false, allowRetries: false, source: 'startup' });
  }

  async runScheduledCollect() {
    return this.runCollect({ notify: true, allowRetries: true, source: 'scheduled' });
  }

  async runCollect({ notify, allowRetries, source }) {
    if (this.collectRunning) return { status: 'already_running' };

    this.collectRunning = true;
    let finalResult;
    const job = this.createCollectJob(source);

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
          const text = `${job.label}: Подарунки ще недоступні. Спроба ${attempt}/${config.runtime.rewardRetryCount} буде пізніше.`;
          logger.warn(text);
          if (this.notify) await this.notify({ type: 'info', text });
          await delay(config.runtime.rewardRetryDelayMs);
          finalResult = await this.collector.collect(job);
          if (finalResult.status !== 'unavailable') break;
        }
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
    const previousVerifiedRun = this.rewardsRepository.getRecentSuccessful(1)[0] || null;
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
    }

    return resultWithSchedule;
  }
}

module.exports = RewardScheduler;
