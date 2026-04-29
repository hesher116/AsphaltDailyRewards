const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

function dashboardKeyboard(view = 'dashboard') {
  if (view === 'history') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Назад до dashboard', callback_data: 'dashboard' }],
          [
            { text: 'Оновити історію', callback_data: 'history' },
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

async function createTelegramBot() {
  if (!config.telegram.token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const bot = new TelegramBot(config.telegram.token, { polling: false });
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
    return await bot.sendPhoto(chatId, fs.createReadStream(photoPath), {
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
        caption,
        fileOptions: {
          filename: path.basename(photoPath)
        }
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

module.exports = {
  createTelegramBot,
  sendMessageToChat,
  sendPhotoToChat,
  editMessage,
  editCaption,
  editPhotoMedia,
  sendAdminMessage,
  dashboardKeyboard,
  dashboardHeaderPath
};
