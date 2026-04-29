const { nowIso } = require('../utils/time');

class SessionRepository {
  constructor(db) {
    this.db = db;
  }

  getState() {
    const row = this.db.prepare('SELECT * FROM session_state WHERE key = ?').get('main');
    return {
      authStatus: row.auth_status,
      waitingOtpSince: row.waiting_otp_since,
      lastSuccessfulLoginAt: row.last_successful_login_at,
      lastSuccessfulCollectAt: row.last_successful_collect_at,
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      schedulerOffsetMs: row.scheduler_offset_ms,
      dashboardMessageId: row.dashboard_message_id,
      dashboardChatId: row.dashboard_chat_id,
      dashboardRecentActions: row.dashboard_recent_actions_json,
      dashboardRecentMessages: row.dashboard_recent_messages_json,
      activeBrowserSession: Boolean(row.active_browser_session),
      updatedAt: row.updated_at
    };
  }

  update(partial) {
    const current = this.getState();
    const next = {
      authStatus: Object.hasOwn(partial, 'authStatus') ? partial.authStatus : current.authStatus,
      waitingOtpSince: Object.hasOwn(partial, 'waitingOtpSince') ? partial.waitingOtpSince : current.waitingOtpSince,
      lastSuccessfulLoginAt: Object.hasOwn(partial, 'lastSuccessfulLoginAt')
        ? partial.lastSuccessfulLoginAt
        : current.lastSuccessfulLoginAt,
      lastSuccessfulCollectAt: Object.hasOwn(partial, 'lastSuccessfulCollectAt')
        ? partial.lastSuccessfulCollectAt
        : current.lastSuccessfulCollectAt,
      lastRunAt: Object.hasOwn(partial, 'lastRunAt') ? partial.lastRunAt : current.lastRunAt,
      nextRunAt: Object.hasOwn(partial, 'nextRunAt') ? partial.nextRunAt : current.nextRunAt,
      schedulerOffsetMs: Object.hasOwn(partial, 'schedulerOffsetMs') ? partial.schedulerOffsetMs : current.schedulerOffsetMs,
      dashboardMessageId: Object.hasOwn(partial, 'dashboardMessageId') ? partial.dashboardMessageId : current.dashboardMessageId,
      dashboardChatId: Object.hasOwn(partial, 'dashboardChatId') ? partial.dashboardChatId : current.dashboardChatId,
      dashboardRecentActions: Object.hasOwn(partial, 'dashboardRecentActions')
        ? partial.dashboardRecentActions
        : current.dashboardRecentActions,
      dashboardRecentMessages: Object.hasOwn(partial, 'dashboardRecentMessages')
        ? partial.dashboardRecentMessages
        : current.dashboardRecentMessages,
      activeBrowserSession: Object.hasOwn(partial, 'activeBrowserSession')
        ? partial.activeBrowserSession
        : current.activeBrowserSession
    };

    this.db.prepare(`
      UPDATE session_state
      SET
        auth_status = ?,
        waiting_otp_since = ?,
        last_successful_login_at = ?,
        last_successful_collect_at = ?,
        last_run_at = ?,
        next_run_at = ?,
        scheduler_offset_ms = ?,
        dashboard_message_id = ?,
        dashboard_chat_id = ?,
        dashboard_recent_actions_json = ?,
        dashboard_recent_messages_json = ?,
        active_browser_session = ?,
        updated_at = ?
      WHERE key = 'main'
    `).run(
      next.authStatus,
      next.waitingOtpSince,
      next.lastSuccessfulLoginAt,
      next.lastSuccessfulCollectAt,
      next.lastRunAt,
      next.nextRunAt,
      next.schedulerOffsetMs || 0,
      next.dashboardMessageId,
      next.dashboardChatId,
      next.dashboardRecentActions || '[]',
      next.dashboardRecentMessages || '[]',
      next.activeBrowserSession ? 1 : 0,
      nowIso()
    );

    return this.getState();
  }

  setWaitingOtp() {
    return this.update({
      authStatus: 'waiting_otp',
      waitingOtpSince: nowIso()
    });
  }

  setLoggedIn() {
    return this.update({
      authStatus: 'logged_in',
      waitingOtpSince: null,
      lastSuccessfulLoginAt: nowIso(),
      activeBrowserSession: true
    });
  }

  setSessionLost() {
    return this.update({
      authStatus: 'session_lost',
      waitingOtpSince: null
    });
  }
}

module.exports = SessionRepository;
