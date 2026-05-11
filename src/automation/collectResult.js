const { formatDateTime } = require('../utils/time');

const SUCCESS_STATUSES = new Set(['success']);
const VERIFIED_COLLECT_STATUSES = new Set(['success', 'needs_review']);

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function isCollectSuccess(status) {
  return SUCCESS_STATUSES.has(status);
}

function isVerifiedCollect(status) {
  return VERIFIED_COLLECT_STATUSES.has(status);
}

function normalizeCollectResult(result = {}, options = {}) {
  const rewards = Array.isArray(result.rewards) ? result.rewards : [];
  const collectedCount = isFiniteNumber(result.collectedCount) ? Number(result.collectedCount) : rewards.length;
  const expectedCount = isFiniteNumber(result.expectedCount) ? Number(result.expectedCount) : 2;
  const status = result.status || inferStatus(collectedCount, expectedCount);

  return {
    status,
    rewards,
    imagePaths: Array.isArray(result.imagePaths) ? result.imagePaths : [],
    description: result.description || buildDescription(status, collectedCount, expectedCount),
    error: result.error || null,
    technicalStatus: result.technicalStatus || `collected ${collectedCount}/${expectedCount}`,
    collectedCount,
    expectedCount,
    jobId: result.jobId || (options.job ? options.job.id : null) || null,
    jobLabel: result.jobLabel || (options.job ? options.job.label : null) || null,
    source: result.source || options.source || (options.job ? options.job.source : null) || null,
    verifiedAt: result.verifiedAt || null,
    nextRunAt: result.nextRunAt || options.nextRunAt || null,
    schedulePreserved: Boolean(result.schedulePreserved || options.schedulePreserved),
    scheduleChanged: Boolean(result.scheduleChanged || options.scheduleChanged),
    createdAt: result.createdAt || null,
    id: result.id || null
  };
}

function inferStatus(collectedCount, expectedCount) {
  if (expectedCount <= 0) return 'unavailable';
  if (collectedCount >= expectedCount) return 'success';
  if (collectedCount > 0) return 'partial';
  return 'unavailable';
}

function buildDescription(status, collectedCount, expectedCount) {
  if (status === 'session_lost') return 'Session lost before reward collection';
  if (status === 'error') return 'Reward collection failed';
  if (status === 'unavailable') return 'Daily rewards are not available yet';
  if (status === 'needs_review') return `Collected ${collectedCount}/${expectedCount} daily rewards; manual review requested`;
  return `Collected ${collectedCount}/${expectedCount} daily rewards`;
}

function progressText(result) {
  const normalized = normalizeCollectResult(result);
  return `collected ${normalized.collectedCount}/${normalized.expectedCount}`;
}

function rewardTextInline(rewards) {
  if (!rewards || rewards.length === 0) return 'нагороди не отримано';
  return rewards.map((reward, index) => `${index + 1}. ${reward.name}`).join('; ');
}

function collectStatusTitle(result, scheduled = false) {
  const prefix = scheduled ? 'Плановий збір' : 'Збір';
  if (result.status === 'success') return `${prefix} завершено успішно`;
  if (result.status === 'needs_review') return `${prefix}: потрібна ручна перевірка`;
  if (result.status === 'partial') return `${prefix} завершено частково`;
  if (result.status === 'session_lost') return 'Потрібна повторна авторизація';
  if (result.status === 'error') return 'Не вдалося зібрати подарунки';
  return 'Подарунки зараз недоступні';
}

function buildCollectSummary(result, nextRunAt = result.nextRunAt, options = {}) {
  const normalized = normalizeCollectResult(result, { nextRunAt });
  const jobText = normalized.jobLabel ? `${normalized.jobLabel}. ` : '';
  const preserved = normalized.schedulePreserved
    ? ' Графік не змінено: це була невдала ручна спроба.'
    : '';
  const changed = normalized.scheduleChanged ? ' Графік оновлено.' : '';

  return [
    `${jobText}${collectStatusTitle(normalized, options.scheduled)}.`,
    `Отримано: ${rewardTextInline(normalized.rewards)}.`,
    `Статус: ${progressText(normalized)}.`,
    normalized.status === 'needs_review' ? 'Доступний був лише 1 reward: перевір вручну, чи магазин справді порожній.' : '',
    `Наступний збір: ${formatDateTime(nextRunAt)}.`,
    `${changed}${preserved}`.trim()
  ].filter(Boolean).join(' ');
}

module.exports = {
  buildCollectSummary,
  collectStatusTitle,
  isCollectSuccess,
  isVerifiedCollect,
  normalizeCollectResult,
  progressText,
  rewardTextInline
};
