const EventEmitter = require('events');
const fs = require('fs/promises');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

function dashboardKeyboard(view = 'dashboard') {
  if (view === 'history' || view === 'recent_collects') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Назад до dashboard', callback_data: 'dashboard' }],
          [
            { text: view === 'history' ? 'Оновити історію' : 'Оновити збори', callback_data: view },
            { text: 'Статус', callback_data: 'status' }
          ]
        ]
      }
    };
  }

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Увійти', callback_data: 'login' },
          { text: 'Перевірити сесію', callback_data: 'check_session' }
        ],
        [
          { text: 'Зібрати подарунки', callback_data: 'collect' },
          { text: 'Статус', callback_data: 'status' }
        ],
        [
          { text: 'Історія', callback_data: 'history' },
          { text: 'Останні збори', callback_data: 'recent_collects' }
        ]
      ]
    }
  };
}

function dashboardHeaderPath() {
  return path.resolve(process.cwd(), 'dashboard_header.png');
}

class TelegramApiError extends Error {
  constructor(payload) {
    super(`ETELEGRAM: ${payload.error_code || 'unknown'} ${payload.description || 'Telegram API error'}`);
    this.code = 'ETELEGRAM';
    this.response = payload;
  }
}

class SimpleTelegramBot extends EventEmitter {
  constructor(token) {
    super();
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.textHandlers = [];
    this.polling = false;
    this.offset = 0;
  }

  onText(regex, handler) {
    this.textHandlers.push({ regex, handler });
  }

  async startPolling() {
    if (this.polling) return;
    this.polling = true;
    this.pollLoop().catch((error) => this.emit('polling_error', error));
  }

  async stopPolling() {
    this.polling = false;
  }

  async deleteWebHook(options = {}) {
    return this.requestJson('deleteWebhook', options);
  }

  async sendMessage(chatId, text, options = {}) {
    return this.requestJson('sendMessage', {
      chat_id: chatId,
      text,
      ...options
    });
  }

  async sendPhoto(chatId, photo, options = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', await this.fileBlob(photo), path.basename(photo.path || String(photo)));
    this.appendFormOptions(form, options);
    return this.requestForm('sendPhoto', form);
  }

  async editMessageText(text, options = {}) {
    return this.requestJson('editMessageText', {
      text,
      ...options
    });
  }

  async editMessageCaption(caption, options = {}) {
    return this.requestJson('editMessageCaption', {
      caption,
      ...options
    });
  }

  async editMessageMedia(media, options = {}) {
    const form = new FormData();
    const mediaPayload = { ...media };
    const attachPath = String(media.media || '').replace(/^attach:\/\//, '');
    mediaPayload.media = 'attach://media_file';
    delete mediaPayload.fileOptions;

    form.append('media', JSON.stringify(mediaPayload));
    form.append('media_file', await this.fileBlob(attachPath), path.basename(attachPath));
    this.appendFormOptions(form, options);
    return this.requestForm('editMessageMedia', form);
  }

  async deleteMessage(chatId, messageId) {
    return this.requestJson('deleteMessage', {
      chat_id: chatId,
      message_id: messageId
    });
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    return this.requestJson('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...options
    });
  }

  async pollLoop() {
    while (this.polling) {
      try {
        const payload = await this.requestJson('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query']
        });

        for (const update of payload) {
          this.offset = update.update_id + 1;
          await this.dispatchUpdate(update);
        }
      } catch (error) {
        this.emit('polling_error', error);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  async dispatchUpdate(update) {
    if (update.message) {
      this.emit('message', update.message);
      const text = String(update.message.text || '');
      for (const item of this.textHandlers) {
        const match = text.match(item.regex);
        if (match) await item.handler(update.message, match);
      }
    }

    if (update.callback_query) {
      this.emit('callback_query', update.callback_query);
    }
  }

  async requestJson(method, body) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return this.parseResponse(response);
  }

  async requestForm(method, form) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      body: form
    });
    return this.parseResponse(response);
  }

  async parseResponse(response) {
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok === false) {
      throw new TelegramApiError(payload || { error_code: response.status, description: response.statusText });
    }
    return payload.result;
  }

  async fileBlob(file) {
    const filePath = file.path || String(file);
    const buffer = await fs.readFile(filePath);
    return new Blob([buffer]);
  }

  appendFormOptions(form, options) {
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
}

async function createTelegramBot() {
  if (!config.telegram.token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const bot = new SimpleTelegramBot(config.telegram.token);
  await bot.deleteWebHook({ drop_pending_updates: false }).catch((error) => {
    logger.warn('Не вдалося вимкнути Telegram webhook');
    logger.debug({ error }, 'deleteWebHook failed');
  });

  await bot.startPolling();
  logger.info('Telegram-бот запущено');

  bot.on('polling_error', (error) => {
    logger.warn('Telegram-бот тимчасово повернув помилку polling');
    logger.debug({ error }, 'Telegram polling error');
  });

  bot.on('webhook_error', (error) => {
    logger.warn('Telegram webhook повернув помилку');
    logger.debug({ error }, 'Telegram webhook error');
  });

  return bot;
}

async function sendMessageToChat(bot, chatId, text, options = {}) {
  if (!chatId) {
    logger.warn('TELEGRAM_CHAT_ID не задано. Напиши боту /start і впиши правильний chat id у .env');
    return null;
  }

  try {
    return await bot.sendMessage(chatId, text, {
      disable_web_page_preview: true,
      ...options
    });
  } catch (error) {
    if (String(error.message || '').includes('chat not found')) {
      logger.telegramChatNotFound(error);
    } else {
      logger.warn('Не вдалося надіслати повідомлення в Telegram');
      logger.debug({ error }, 'sendMessage failed');
    }
    return null;
  }
}

async function editMessage(bot, chatId, messageId, text, options = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      disable_web_page_preview: true,
      ...options
    });
  } catch (error) {
    if (String(error.message || '').includes('message is not modified')) return true;
    logger.debug({ error }, 'editMessageText failed');
    return null;
  }
}

async function sendPhotoToChat(bot, chatId, photoPath, caption, options = {}) {
  if (!chatId) {
    logger.warn('TELEGRAM_CHAT_ID не задано. Напиши боту /start і впиши правильний chat id у .env');
    return null;
  }

  try {
    return await bot.sendPhoto(chatId, photoPath, {
      caption,
      ...options
    });
  } catch (error) {
    if (String(error.message || '').includes('chat not found')) {
      logger.telegramChatNotFound(error);
    } else {
      logger.warn('Не вдалося надіслати dashboard image у Telegram');
      logger.debug({ error }, 'sendPhoto failed');
    }
    return null;
  }
}

async function editCaption(bot, chatId, messageId, caption, options = {}) {
  try {
    return await bot.editMessageCaption(caption, {
      chat_id: chatId,
      message_id: messageId,
      ...options
    });
  } catch (error) {
    if (String(error.message || '').includes('message is not modified')) return true;
    logger.debug({ error }, 'editMessageCaption failed');
    return null;
  }
}

async function editPhotoMedia(bot, chatId, messageId, photoPath, caption, options = {}) {
  try {
    return await bot.editMessageMedia(
      {
        type: 'photo',
        media: `attach://${photoPath}`,
        caption
      },
      {
        chat_id: chatId,
        message_id: messageId,
        ...options
      }
    );
  } catch (error) {
    if (String(error.message || '').includes('message is not modified')) return true;
    logger.debug({ error, photoPath }, 'editMessageMedia failed');
    return null;
  }
}

async function sendAdminMessage(bot, text, options = {}) {
  return sendMessageToChat(bot, config.telegram.chatId, text, options);
}

async function deleteMessageSafe(bot, chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (error) {
    const message = String(error.message || '');
    if (message.includes('message to delete not found') || message.includes('message identifier is not specified')) {
      return;
    }
    logger.debug({ error, chatId, messageId }, 'deleteMessage failed');
  }
}

module.exports = {
  createTelegramBot,
  sendMessageToChat,
  sendPhotoToChat,
  editMessage,
  editCaption,
  editPhotoMedia,
  sendAdminMessage,
  deleteMessageSafe,
  dashboardKeyboard,
  dashboardHeaderPath
};
