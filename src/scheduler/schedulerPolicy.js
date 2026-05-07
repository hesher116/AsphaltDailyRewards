const { isCollectSuccess } = require('../automation/collectResult');

function decideScheduleAction({ result, source }) {
  if (isCollectSuccess(result.status)) {
    return {
      action: 'reschedule_after_success',
      scheduleChanged: true,
      schedulePreserved: false,
      message: 'Графік оновлено після успішного збору'
    };
  }

  if (source === 'manual') {
    return {
      action: 'preserve_manual_failure',
      scheduleChanged: false,
      schedulePreserved: true,
      message: 'Графік не змінено: це була невдала ручна спроба'
    };
  }

  if (source === 'startup') {
    return {
      action: 'preserve_startup_failure',
      scheduleChanged: false,
      schedulePreserved: true,
      message: 'Графік не змінено: startup збір не вдався'
    };
  }

  return {
    action: 'reschedule_scheduled_failure',
    scheduleChanged: true,
    schedulePreserved: false,
    message: 'Графік оновлено після невдалого планового збору'
  };
}

module.exports = {
  decideScheduleAction
};
