const EventEmitter = require('events');
const logger = require('../utils/logger');

class StatusReporter extends EventEmitter {
  constructor() {
    super();
    this.context = null;
  }

  setContext(context) {
    this.context = context || null;
  }

  clearContext() {
    this.context = null;
  }

  formatMessage(message) {
    if (!this.context || !this.context.label) return message;
    return `${this.context.label}: ${message}`;
  }

  report(message, level = 'info') {
    const formattedMessage = this.formatMessage(message);

    if (level === 'success') logger.success(formattedMessage);
    else if (level === 'warn') logger.warn(formattedMessage);
    else if (level === 'error') logger.error(formattedMessage);
    else logger.info(formattedMessage);

    this.emit('status', {
      message: formattedMessage,
      rawMessage: message,
      level,
      at: new Date().toISOString(),
      context: this.context
    });
  }
}

module.exports = StatusReporter;
