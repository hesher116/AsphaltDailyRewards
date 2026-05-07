const fs = require('fs');
const config = require('../config');
const { formatDateTime } = require('../utils/time');
const {
  dashboardHeaderPath,
  dashboardKeyboard,
  editMessage,
  editPhotoMedia,
  sendAdminMessage,
  sendPhotoToChat
} = require('./telegramBot');

const MAX_RECENT_ITEMS = 5;
const MAX_CAPTION_LENGTH = 1000;

function nowIso() {
  return new Date().toISOString();
}

function formatTime(isoOrDate) {
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function truncate(text, limit) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}...`;
}

function statusLabels(authStatus) {
  return {
    sessionStatus: authStatus === 'logged_in' ? 'Активна' : 'Неактивна',
    otpStatus: authStatus === 'waiting_otp' ? 'Очікується' : 'Не очікується'
  };
}

class Dashboard {
  constructor({ bot, statusReporter, sessionRepository, scheduler }) {
    this.bot = bot;
    this.statusReporter = statusReporter;
    this.sessionRepository = sessionRepository;
    this.scheduler = scheduler;
    this.state = {
      status: 'Очікую команду',
      currentOperation: 'Очікую команду',
      recentActions: [{ text: 'Запуск системи', at: nowIso() }],
      recentMessages: [{ text: 'Очікую команду', at: nowIso() }],
      recentCollects: [],
      currentView: 'dashboard',
      historyRuns: []
    };
    this.messageId = null;
    this.chatId = config.telegram.chatId || null;
    this.busy = false;
    this.updateChain = Promise.resolve();
    this.boundHandler = (event) => {
      this.setStatus(event.message, { message: event.message, action: event.message }).catch(() => {});
    };
  }

  start() {
    const persisted = this.sessionRepository.getState();
    this.messageId = persisted.dashboardMessageId || null;
    this.chatId = persisted.dashboardChatId || config.telegram.chatId || null;
    this.state.recentActions = this.parsePersistedList(persisted.dashboardRecentActions, this.state.recentActions);
    this.state.recentMessages = this.parsePersistedList(persisted.dashboardRecentMessages, this.state.recentMessages);
    this.statusReporter.on('status', this.boundHandler);
  }

  stop() {
    this.statusReporter.off('status', this.boundHandler);
  }

  addBuffered(listName, value) {
    const text = truncate(value, 140);
    if (!text) return;
    const list = this.state[listName];
    const last = list[list.length - 1];
    if (this.entryText(last) === text) return;
    list.push({ text, at: nowIso() });
    this.state[listName] = list.slice(-MAX_RECENT_ITEMS);
  }

  addAction(action) {
    this.addBuffered('recentActions', action);
    this.persistBuffers();
  }

  addMessage(message) {
    this.addBuffered('recentMessages', message);
    this.persistBuffers();
  }

  parsePersistedList(value, fallback) {
    try {
      const parsed = JSON.parse(value || '[]');
      if (!Array.isArray(parsed) || !parsed.length) return fallback;
      return parsed.map((item) => {
        if (typeof item === 'string') return { text: item, at: null };
        return {
          text: item && item.text ? String(item.text) : '',
          at: item && item.at ? item.at : null
        };
      }).filter((item) => item.text).slice(-MAX_RECENT_ITEMS);
    } catch {
      return fallback;
    }
  }

  persistBuffers() {
    this.sessionRepository.update({
      dashboardRecentActions: JSON.stringify(this.state.recentActions.slice(-MAX_RECENT_ITEMS)),
      dashboardRecentMessages: JSON.stringify(this.state.recentMessages.slice(-MAX_RECENT_ITEMS))
    });
  }

  async setBusy(value, action) {
    this.busy = value;
    this.state.currentOperation = value ? action || 'Виконується дія' : 'Очікую команду';
    if (action) this.addAction(action);
    if (value) this.state.currentView = 'dashboard';
    await this.render();
  }

  async setStatus(status, { action, lastAction, message, lastMessage, operation } = {}) {
    this.state.currentView = 'dashboard';
    this.state.status = status || this.state.status;
    this.state.currentOperation = operation || action || lastAction || status || this.state.currentOperation;
    this.addAction(action || lastAction || status);
    this.addMessage(message || lastMessage || status);
    await this.render();
  }

  async showDashboard(message) {
    this.state.currentView = 'dashboard';
    if (message) this.addMessage(message);
    await this.render();
  }

  async showHistory(runs) {
    this.state.currentView = 'history';
    this.state.historyRuns = runs || [];
    this.addAction('Відкрито історію');
    this.addMessage(this.state.historyRuns.length
      ? `Показую останні ${this.state.historyRuns.length} записів історії`
      : 'Історія поки порожня');
    await this.render();
  }

  async showRecentCollects(runs) {
    this.state.currentView = 'recent_collects';
    this.state.recentCollects = runs || [];
    this.addAction('Відкрито останні збори');
    this.addMessage(this.state.recentCollects.length
      ? `Показую останні ${this.state.recentCollects.length} успішні збори`
      : 'Успішних зборів поки немає');
    await this.render();
  }

  async resetMessage() {
    if (this.messageId && this.chatId) {
      await this.bot.deleteMessage(this.chatId, this.messageId).catch(() => {});
    }
    this.messageId = null;
    this.sessionRepository.update({ dashboardMessageId: null, dashboardChatId: null });
    this.addAction('Dashboard перестворено');
    this.addMessage('Dashboard буде створено заново');
    await this.render();
  }

  async render() {
    this.updateChain = this.updateChain.then(() => this.renderNow()).catch(() => {});
    return this.updateChain;
  }

  async renderNow() {
    const text = this.buildText();
    const keyboard = dashboardKeyboard(this.state.currentView);
    const photoPath = this.getCurrentPhotoPath();

    if (this.messageId) {
      const edited = photoPath
        ? await editPhotoMedia(this.bot, this.chatId, this.messageId, photoPath, text, keyboard)
        : await editMessage(this.bot, this.chatId, this.messageId, text, keyboard);
      if (edited) return;
      await this.bot.deleteMessage(this.chatId, this.messageId).catch(() => {});
      this.messageId = null;
      this.sessionRepository.update({ dashboardMessageId: null });
    }

    const sent = photoPath
      ? await sendPhotoToChat(this.bot, this.chatId, photoPath, text, keyboard)
      : await sendAdminMessage(this.bot, text, keyboard);

    if (sent && sent.message_id) {
      this.messageId = sent.message_id;
      this.chatId = sent.chat ? sent.chat.id : this.chatId;
      this.sessionRepository.update({
        dashboardMessageId: sent.message_id,
        dashboardChatId: this.chatId
      });
    }
  }

  getCurrentPhotoPath() {
    if (this.state.currentView === 'recent_collects') {
      for (const run of this.state.recentCollects || []) {
        for (const imagePath of run.imagePaths || []) {
          if (imagePath && fs.existsSync(imagePath)) return imagePath;
        }
      }
    }
    return fs.existsSync(dashboardHeaderPath()) ? dashboardHeaderPath() : null;
  }

  buildText() {
    if (this.state.currentView === 'history') return this.buildHistoryText();
    if (this.state.currentView === 'recent_collects') return this.buildRecentCollectsText();
    return this.buildDashboardText();
  }

  buildDashboardText() {
    const persisted = this.sessionRepository.getState();
    const labels = statusLabels(persisted.authStatus);
    const status = this.busy ? this.state.status || 'Виконується дія' : this.state.status;
    const operation = this.busy ? this.state.currentOperation : 'Очікую команду';
    const collectState = this.scheduler && this.scheduler.isRunning() ? 'Виконується' : 'Не виконується';
    const actions = this.formatList(this.state.recentActions, 'Поки немає дій');
    const messages = this.formatList(this.state.recentMessages, 'Поки немає повідомлень');

    return truncate([
      'Asphalt Daily Rewards',
      '',
      `Статус: ${status}`,
      `Операція: ${operation}`,
      `Збір: ${collectState}`,
      `Сесія: ${labels.sessionStatus}`,
      `OTP: ${labels.otpStatus}`,
      `Останній успішний збір: ${formatDateTime(persisted.lastSuccessfulCollectAt)}`,
      `Наступний збір: ${formatDateTime(persisted.nextRunAt)}`,
      '',
      'Останні дії:',
      actions,
      '',
      'Останні повідомлення:',
      messages
    ].join('\n'), MAX_CAPTION_LENGTH);
  }

  buildHistoryText() {
    const persisted = this.sessionRepository.getState();
    const rows = this.state.historyRuns.length
      ? this.state.historyRuns.map((run) => {
          const rewards = (run.rewards || []).map((reward) => reward.name).join(', ') || 'без нагород';
          return `#${run.id} ${formatDateTime(run.createdAt)} - ${run.status}: ${rewards}`;
        }).join('\n')
      : 'Історія поки порожня.';

    return truncate([
      'Asphalt Daily Rewards',
      '',
      'Історія зборів:',
      rows,
      '',
      `Останній успішний збір: ${formatDateTime(persisted.lastSuccessfulCollectAt)}`,
      `Наступний збір: ${formatDateTime(persisted.nextRunAt)}`,
      '',
      'Останні повідомлення:',
      this.formatList(this.state.recentMessages, 'Поки немає повідомлень')
    ].join('\n'), MAX_CAPTION_LENGTH);
  }

  buildRecentCollectsText() {
    const rows = this.state.recentCollects.length
      ? this.state.recentCollects.map((run, index) => {
          const rewards = (run.rewards || []).length
            ? (run.rewards || []).map((reward) => `- ${reward.name}`).join('\n')
            : '- Нагороди не визначено';
          return [
            `Збір #${index + 1}`,
            `Дата: ${formatDateTime(run.createdAt)}`,
            `Статус: ${run.status}`,
            'Нагороди:',
            rewards
          ].join('\n');
        }).join('\n\n')
      : 'Успішних зборів поки немає.';

    return truncate([
      'Asphalt Daily Rewards',
      '',
      'Останні збори',
      '',
      rows,
      '',
      'Останні повідомлення:',
      this.formatList(this.state.recentMessages, 'Поки немає повідомлень')
    ].join('\n'), MAX_CAPTION_LENGTH);
  }

  formatList(items, emptyText) {
    return items.length
      ? items.map((item) => `- ${this.formatEntry(item)}`).join('\n')
      : `- ${emptyText}`;
  }

  entryText(item) {
    if (typeof item === 'string') return item;
    return item && item.text ? item.text : '';
  }

  formatEntry(item) {
    if (typeof item === 'string') return item;
    const time = item.at ? `[${formatTime(item.at)}] ` : '';
    return `${time}${item.text}`;
  }
}

module.exports = Dashboard;
