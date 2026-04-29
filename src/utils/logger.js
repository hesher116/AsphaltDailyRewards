const config = require('../config');

function stamp() {
  return new Date().toLocaleString('uk-UA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function asError(value) {
  if (!value) return null;
  if (value instanceof Error) return value;
  if (value.error instanceof Error) return value.error;
  return null;
}

function logTime() {
  return new Date().toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function write(level, message) {
  process.stdout.write(`[${logTime()}] [${level}] ${message}\n`);
}

function debugDetails(payload, message) {
  if (!config.runtime.debug) return;
  if (message) write('DEBUG', message);
  const error = asError(payload);
  if (error) {
    write('DEBUG', error.stack || error.message);
    return;
  }
  if (payload !== undefined && typeof payload !== 'string') {
    write('DEBUG', JSON.stringify(payload, null, 2));
  }
}

function normalize(arg1, arg2) {
  if (typeof arg1 === 'string') return { message: arg1, payload: undefined };
  return { message: arg2 || 'Технічна подія', payload: arg1 };
}

module.exports = {
  info(arg1, arg2) {
    const { message, payload } = normalize(arg1, arg2);
    write('INFO', message);
    debugDetails(payload);
  },

  success(message) {
    write('SUCCESS', message);
  },

  warn(arg1, arg2) {
    const { message, payload } = normalize(arg1, arg2);
    write('WARN', message);
    debugDetails(payload);
  },

  error(arg1, arg2) {
    const { message, payload } = normalize(arg1, arg2);
    write('ERROR', message);
    debugDetails(payload);
  },

  debug(arg1, arg2) {
    const { message, payload } = normalize(arg1, arg2);
    debugDetails(payload, `${stamp()} ${message}`);
  },

  telegramChatNotFound(error) {
    write('WARN', 'Бот не може написати в Telegram чат');
    write('WARN', 'Перевір, чи ти запустив бота командою /start');
    write('WARN', 'Перевір правильність TELEGRAM_CHAT_ID');
    debugDetails({ error }, 'Telegram API повернув помилку');
  }
};
