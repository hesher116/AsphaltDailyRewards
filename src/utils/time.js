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
  timeZoneName,
  delay
};
