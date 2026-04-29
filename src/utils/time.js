function nowIso() {
  return new Date().toISOString();
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function nextDailyRunDate(config) {
  const jitter = randomInt(config.scheduler.minJitterMs, config.scheduler.maxJitterMs);
  return addMs(new Date(), config.scheduler.baseDelayMs + jitter);
}

function formatDateTime(isoOrDate) {
  if (!isoOrDate) return 'unknown';
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString('uk-UA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatDateTimeForLog(isoOrDate) {
  if (!isoOrDate) return 'невідомо';
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(date.getTime())) return 'невідомо';
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes())
  ].join('');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  nowIso,
  nextDailyRunDate,
  formatDateTime,
  formatDateTimeForLog,
  delay
};
