const config = require('../config');

function nowIso() {
  return new Date().toISOString();
}

function withAppTimeZone(options = {}) {
  return {
    timeZone: config.app.timeZone,
    ...options
  };
}

function zonedParts(date, timeZone = config.app.timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function zonedDateTimeToUtc({ year, month, day, hour, minute, second = 0 }, timeZone = config.app.timeZone) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(utcMs), timeZone);
    const desiredLocalMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    const actualLocalMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second || 0, 0);
    const deltaMs = desiredLocalMs - actualLocalMs;
    if (deltaMs === 0) break;
    utcMs += deltaMs;
  }
  return new Date(utcMs);
}

function nextDailyTimeInAppZone(hour, minute, now = new Date()) {
  const safeHour = Math.min(23, Math.max(0, Number(hour) || 0));
  const safeMinute = Math.min(59, Math.max(0, Number(minute) || 0));
  const today = zonedParts(now);
  let candidate = zonedDateTimeToUtc({
    year: today.year,
    month: today.month,
    day: today.day,
    hour: safeHour,
    minute: safeMinute,
    second: 0
  });

  if (candidate.getTime() <= now.getTime()) {
    const tomorrowUtc = new Date(Date.UTC(today.year, today.month - 1, today.day + 1, 12, 0, 0));
    const tomorrow = zonedParts(tomorrowUtc);
    candidate = zonedDateTimeToUtc({
      year: tomorrow.year,
      month: tomorrow.month,
      day: tomorrow.day,
      hour: safeHour,
      minute: safeMinute,
      second: 0
    });
  }

  return candidate;
}

function formatDateTime(isoOrDate) {
  if (!isoOrDate) return 'unknown';
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString('uk-UA', withAppTimeZone({
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }));
}

function formatDateTimeForLog(isoOrDate) {
  if (!isoOrDate) return 'unknown';
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return new Intl.DateTimeFormat('sv-SE', withAppTimeZone({
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })).format(date);
}

function formatTime(isoOrDate) {
  if (!isoOrDate) return '--:--:--';
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('uk-UA', withAppTimeZone({
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }));
}

function timeZoneName() {
  return config.app.timeZone;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  nowIso,
  formatDateTime,
  formatDateTimeForLog,
  formatTime,
  nextDailyTimeInAppZone,
  timeZoneName,
  delay
};
