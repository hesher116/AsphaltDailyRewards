const config = require('../config');
const logger = require('../utils/logger');
const { delay, nowIso, formatDateTimeForLog } = require('../utils/time');
const { removeOldFiles } = require('../utils/fileCleanup');
const { savePageSnapshot } = require('../utils/debugSnapshot');

function randomOffsetMs() {
  const min = config.scheduler.minJitterMs;
  const max = config.scheduler.maxJitterMs;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

class RewardScheduler {
  constructor({ collector, rewardsRepository, sessionRepository, notify }) {
    this.collector = collector;
    this.rewardsRepository = rewardsRepository;
    this.sessionRepository = sessionRepository;
    this.notify = notify;
    this.timer = null;
    this.collectRunning = false;
    this.stopped = false;
  }

  isRunning() {
    return this.collectRunning;
  }

  start() {
    this.scheduleAt(this.resolveStartupNextRun(this.sessionRepository.getState()));
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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

  scheduleNextAfterSuccess() {
    const now = new Date();
    const nextRunAt = this.computeNextFrom(now);
    this.sessionRepository.update({
      lastRunAt: nowIso(),
      lastSuccessfulCollectAt: now.toISOString(),
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

  async runScheduledCollect() {
    return this.runCollect({ notify: true, allowRetries: true, source: 'scheduled' });
  }

  async runCollect({ notify, allowRetries, source }) {
    if (this.collectRunning) return { status: 'already_running' };

    this.collectRunning = true;
    let finalResult;

    try {
      await removeOldFiles(config.storage.rewardImagesDir, config.storage.imageRetentionDays);
      await removeOldFiles(config.storage.debugSnapshotsDir, config.storage.debugSnapshotRetentionDays);
      finalResult = await this.collector.collect();

      if (allowRetries && finalResult.status === 'unavailable') {
        for (let attempt = 1; attempt <= config.runtime.rewardRetryCount; attempt += 1) {
          const text = `Подарунки ще недоступні. Спроба ${attempt}/${config.runtime.rewardRetryCount} буде пізніше.`;
          logger.warn(text);
          if (this.notify) await this.notify({ type: 'info', text });
          await delay(config.runtime.rewardRetryDelayMs);
          finalResult = await this.collector.collect();
          if (finalResult.status !== 'unavailable') break;
        }
      }
    } catch (error) {
      logger.error('Не вдалося зібрати подарунки');
      logger.debug({ error }, 'Reward collection crashed');
      await savePageSnapshot(this.collector.authFlow.page, 'collector-error');
      finalResult = {
        status: 'error',
        rewards: [],
        imagePaths: [],
        description: 'Reward collection failed',
        error: error.message,
        technicalStatus: 'collector_error'
      };
    } finally {
      this.collectRunning = false;
      await this.collector.authFlow.closeIfIdle();
    }

    const success = finalResult.status === 'success' || finalResult.status === 'partial';
    const now = nowIso();
    let nextRunAt;

    if (success) {
      nextRunAt = this.scheduleNextAfterSuccess();
    } else if (source === 'manual') {
      nextRunAt = this.preserveExistingSchedule();
      this.sessionRepository.update({ lastRunAt: now });
      if (finalResult.status === 'unavailable') {
        logger.warn(`Подарунки зараз недоступні. Наступний збір уже запланований на ${formatDateTimeForLog(nextRunAt)}`);
      }
    } else {
      const nextDate = this.computeNextFrom(new Date());
      nextRunAt = nextDate.toISOString();
      this.sessionRepository.update({ lastRunAt: now, nextRunAt });
      this.scheduleAt(nextDate);
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
      technicalStatus: finalResult.technicalStatus
    });

    const resultWithSchedule = {
      ...finalResult,
      id: run.id,
      createdAt: run.createdAt,
      nextRunAt,
      schedulePreserved: !success && source === 'manual'
    };

    if (notify && this.notify) {
      await this.notify({ type: 'collect_result', result: resultWithSchedule });
    }

    return resultWithSchedule;
  }
}

module.exports = RewardScheduler;
