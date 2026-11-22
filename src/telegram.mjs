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
    send(text) {
      return call('sendMessage', {
        chat_id: profile.chatId,
        text,
        link_preview_options: { is_disabled: true },
      });
    },
    updates(offset) {
      return call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35_000);
    },
  };
}

export function isOwnerMessage(message, profile) {
  return message?.from?.id === profile.ownerId
    && message.from.is_bot === false
    && message.chat?.id === profile.chatId
    && message.chat.type === 'private'
    && Number.isSafeInteger(message.message_id)
    && message.message_id > 0;
}
