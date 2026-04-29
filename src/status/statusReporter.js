const EventEmitter = require('events');
const logger = require('../utils/logger');

class StatusReporter extends EventEmitter {
  report(message, level = 'info') {
    if (level === 'success') logger.success(message);
    else if (level === 'warn') logger.warn(message);
    else if (level === 'error') logger.error(message);
    else logger.info(message);

    this.emit('status', {
      message,
      level,
      at: new Date().toISOString()
    });
  }
}

module.exports = StatusReporter;
