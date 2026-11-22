export class TelegramError extends Error {
  constructor(code) {
    super('Telegram API не подтвердил запрос.');
    this.code = code;
  }
}

export function telegramClient(profile, stopSignal) {
  async function call(method, params, timeout = 10_000) {
    let response;
    let payload;
    try {
      response = await fetch(`https://api.telegram.org/bot${profile.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        redirect: 'error',
        signal: AbortSignal.any([stopSignal, AbortSignal.timeout(timeout)]),
      });
      payload = await response.json();
    } catch {
      throw new TelegramError(response?.status);
    }
    if (!response.ok || payload?.ok !== true) {
      throw new TelegramError(payload?.error_code || response.status);
    }
    return payload.result;
  }

  return {
    async verifyIdentity() {
      const bot = await call('getMe', {});
      if (bot?.id !== profile.botId || bot.is_bot !== true) return false;
      const chat = await call('getChat', { chat_id: profile.chatId });
      return chat?.id === profile.chatId && chat.type === 'private';
    },
    /** @param {{replyTo?: number, keyboard?: {text: string, callback_data: string}[][]}} [options] */
    send(text, options = {}) {
      return call('sendMessage', {
        chat_id: profile.chatId,
        text,
        link_preview_options: { is_disabled: true },
        reply_parameters: options.replyTo === undefined ? undefined : { message_id: options.replyTo },
        reply_markup: options.keyboard === undefined ? undefined : { inline_keyboard: options.keyboard },
      });
    },
    answerCallback(id, text) {
      return call('answerCallbackQuery', { callback_query_id: id, text });
    },
    completeChoice(messageId, text) {
      return call('editMessageText', {
        chat_id: profile.chatId,
        message_id: messageId,
        text,
        reply_markup: { inline_keyboard: [] },
      });
    },
    updates(offset) {
      return call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35_000);
    },
  };
}

export function isOwnerMessage(message, profile) {
  return message?.from?.id === profile.ownerId
    && message.from.is_bot === false
    && isPrivateMessage(message, profile);
}

export function isOwnerCallback(query, profile) {
  return typeof query?.id === 'string'
    && query.id.length > 0
    && typeof query.data === 'string'
    && query.from?.id === profile.ownerId
    && query.from.is_bot === false
    && isPrivateMessage(query.message, profile)
    && query.message.from?.id === profile.botId
    && query.message.from.is_bot === true
    && Number.isSafeInteger(query.message.date)
    && query.message.date > 0;
}

function isPrivateMessage(message, profile) {
  return message?.chat?.id === profile.chatId
    && message.chat.type === 'private'
    && Number.isSafeInteger(message.message_id)
    && message.message_id > 0;
}
