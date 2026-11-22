import { openAppServer } from './codex.mjs';
import { readProfile } from './profile.mjs';
import { isOwnerMessage, telegramClient, TelegramError } from './telegram.mjs';

const unavailable = 'Ответ не доставлен. Проверьте исходную сессию Codex на компьютере.';
const unknown = 'Codex не подтвердил результат. Проверьте историю и очередь сессии на компьютере перед повтором.';
const delivered = 'Codex принял ваш ответ.';

function isLiveThread(thread, threadId) {
  return thread?.id === threadId && ['idle', 'active'].includes(thread.status?.type);
}

// Telegram accepts up to 4096 characters. Keep each part independently replyable.
function* withHeader(header, text) {
  const maxBody = 4096 - header.length;
  let remaining = text;
  while (remaining.length) {
    let cut = Math.min(maxBody, remaining.length);
    if (cut < remaining.length && /[\uD800-\uDBFF]/.test(remaining[cut - 1])) cut--;
    yield header + remaining.slice(0, cut);
    remaining = remaining.slice(cut);
  }
}

async function runReceiver(telegram, profile, threadIds, stopSignal) {
  const sessions = new Map();
  const messageBindings = new Map();
  let outgoing = Promise.resolve();
  const codex = openAppServer((method, event) => {
    const session = sessions.get(event?.threadId);
    if (!session) return;
    if (method === 'thread/closed' || method === 'thread/archived' || method === 'thread/deleted'
      || (method === 'thread/status/changed' && event.status?.type === 'notLoaded')) {
      sessions.delete(event.threadId);
    }
    if (method === 'thread/name/updated' && typeof event.threadName === 'string') {
      session.name = event.threadName;
    }
    if (method !== 'item/completed' || event.item?.type !== 'agentMessage' || typeof event.item.text !== 'string') {
      return;
    }
    outgoing = outgoing.then(async () => {
      if (!(await session.ready) || sessions.get(event.threadId) !== session || !event.item.text.trim()) return;
      const name = session.name.replace(/\s+/g, ' ').trim().slice(0, 160) || event.threadId;
      const header = `Codex · ${name}\n\n`;
      for (const text of withHeader(header, event.item.text)) {
        const published = await telegram.send(text);
        if (Number.isSafeInteger(published?.message_id) && published.message_id > 0) {
          messageBindings.set(published.message_id, session);
        }
      }
    }).catch(() => console.error('Не удалось опубликовать сообщение Codex в Telegram.'));
  });

  try {
    await codex.initialize();
    for (const threadId of threadIds) {
      if (!await codex.isLoaded(threadId)) continue;
      const thread = await codex.read(threadId);
      if (!isLiveThread(thread, threadId)) continue;
      const session = { threadId, name: typeof thread.name === 'string' ? thread.name : '', ready: null };
      sessions.set(threadId, session);
      // Resume can hydrate history if the thread was unloaded after the check.
      // Inbound replies require a binding to a new item event on this connection.
      session.ready = codex.subscribe(threadId).then((resumed) => isLiveThread(resumed, threadId), () => false);
      if (!await session.ready) sessions.delete(threadId);
    }
    if (!sessions.size) {
      console.error('Приём выключен. Общий App Server не подтвердил ни одной указанной сессии Codex.');
      return 1;
    }

    console.log('Приём Telegram запущен.');
    let offset;
    while (!stopSignal.aborted) {
      const updates = await telegram.updates(offset);
      if (!Array.isArray(updates)) throw new TelegramError();
      for (const update of updates) {
        if (stopSignal.aborted) return 0;
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || update.update_id < offset) continue;
        offset = update.update_id + 1;
        const message = update.message;
        if (!isOwnerMessage(message, profile) || typeof message.text !== 'string' || !message.text.trim()) continue;
        const reply = message.reply_to_message;
        if (!reply) continue;
        await outgoing;
        const session = reply.from?.id === profile.botId && reply.from.is_bot === true
          ? messageBindings.get(reply.message_id)
          : undefined;
        let result = 'unavailable';
        if (session && sessions.get(session.threadId) === session) {
          let thread;
          try {
            if (await codex.isLoaded(session.threadId)) thread = await codex.read(session.threadId);
          } catch {
            // Connection failed before there was an attempt to submit this text.
          }
          if (isLiveThread(thread, session.threadId) && !stopSignal.aborted
            && sessions.get(session.threadId) === session) result = await codex.deliver(thread, message.text);
        }
        await telegram.send({ unavailable, unknown, delivered }[result]).catch(() => {
          console.error('Telegram не подтвердил отправку статуса ответа.');
        });
      }
    }
    return 0;
  } finally {
    codex.close();
  }
}

async function main(args) {
  const [command, ...threadIds] = args;
  if (command !== 'start' || !threadIds.length || threadIds.some((id) => !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))) {
    console.error('Запуск: node src/receiver.mjs start <идентификатор-сессии-Codex> [...]');
    return 1;
  }

  let profile;
  try {
    profile = await readProfile();
  } catch {
    console.error('Приём выключен. Проверьте файлы и права доступа профиля ~/.telegram вне Git.');
    return 1;
  }
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    const telegram = telegramClient(profile, stop.signal);
    if (!await telegram.verifyIdentity()) {
      console.error('Приём выключен. Telegram не подтвердил ID бота и закреплённый личный чат.');
      return 1;
    }
    return await runReceiver(telegram, profile, new Set(threadIds.map((id) => id.toLowerCase())), stop.signal);
  } catch (error) {
    if (stop.signal.aborted) return 0;
    const reason = error instanceof TelegramError
      ? (error.code === 409 ? 'Конфликт получателей Telegram.' : 'Ошибка связи с Telegram.')
      : 'Ошибка связи с общим App Server Codex.';
    console.error(`Приём выключен. ${reason}`);
    return 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

process.exitCode = await main(process.argv.slice(2));
