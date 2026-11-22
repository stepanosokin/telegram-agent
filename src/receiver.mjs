import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { openAppServer } from './codex.mjs';
import { codexChoices } from './codex-choices.mjs';
import { openCodeForms } from './opencode-forms.mjs';
import { codexPermission, openCodePermissionDescription, permissions } from './permissions.mjs';
import { readProfile } from './profile.mjs';
import { isOwnerCallback, isOwnerMessage, telegramClient, TelegramError } from './telegram.mjs';

function deliveryStatus(result, agent) {
  if (result === 'delivered') return `${agent} принял ваш ответ.`;
  if (result === 'unknown') return `${agent} не подтвердил результат. Проверьте историю и очередь сессии на компьютере перед повтором.`;
  return `Ответ не доставлен. Проверьте исходную сессию${agent ? ' ' + agent : ''} на компьютере.`;
}

function isLiveThread(thread, threadId) {
  return thread?.id === threadId && ['idle', 'active'].includes(thread.status?.type);
}

function sessionSuffix(threadId, threadIds) {
  const suffix = threadId.slice(-8);
  return [...threadIds].some((id) => id !== threadId && id.endsWith(suffix)) ? threadId : `…${suffix}`;
}

function sessionLabel(session, maxNameLength) {
  const name = session.name.replace(/\s+/g, ' ').trim();
  const displayName = [...name].slice(0, maxNameLength).join('') || 'Без названия';
  return `${session.agent} · ${session.suffix} · ${displayName}`;
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

async function runReceiver(telegram, profile, threadIds, openCodeIds, stopSignal) {
  const sessions = new Map();
  const messageBindings = new Map();
  const drafts = new Map();
  const defaultAgent = !openCodeIds.size ? 'Codex' : !threadIds.size ? 'OpenCode' : undefined;
  let outgoing = Promise.resolve();
  const choices = codexChoices(telegram, (session) => sessionLabel(session, 160));
  const forms = openCodeForms(telegram, (session) => sessionLabel(session, 160));
  const approvals = permissions(telegram, (session) => sessionLabel(session, 160), bindMessage);

  function bindMessage(session, published) {
    if (sessions.get(session.key) === session && Number.isSafeInteger(published?.message_id) && published.message_id > 0) {
      session.confirmed = true;
      messageBindings.set(published.message_id, session);
    }
  }

  async function publish(session, body) {
    if (!body.trim()) return;
    const header = `${sessionLabel(session, 160)}\n\n`;
    for (const text of withHeader(header, body)) {
      bindMessage(session, await telegram.send(text));
    }
  }

  const codex = threadIds.size ? openAppServer((method, event, requestId) => {
    const key = `Codex:${event?.threadId}`;
    if (method === 'serverRequest/resolved') {
      void choices.resolve(event?.threadId, event?.requestId);
      approvals.resolve(key, event?.requestId);
    }
    const session = sessions.get(key);
    if (!session) return;
    if (method === 'thread/closed' || method === 'thread/archived' || method === 'thread/deleted'
      || (method === 'thread/status/changed' && event.status?.type === 'notLoaded')) {
      sessions.delete(key);
      choices.clearThread(session.id);
      approvals.clear('Codex', session.id);
      return;
    }
    if (method === 'turn/completed') {
      choices.finishTurn(session.id, event.turn?.id);
      approvals.clear('Codex', session.id, { matches: (id) => id === event.turn?.id });
    }
    if (method === 'turn/started') {
      choices.startTurn(session.id, event.turn?.id);
      approvals.clear('Codex', session.id, { matches: (id) => id !== event.turn?.id });
    }
    if (requestId !== undefined) {
      if (method === 'item/tool/requestUserInput') {
        void choices.publish(session, requestId, event, confirmCodexTurn)
          .catch(() => console.error('Не удалось опубликовать запрос выбора Codex в Telegram.'));
      } else if (typeof event.turnId === 'string' && event.turnId) {
        const publication = approvals.publish({
          session, id: requestId, turnId: event.turnId,
          details: codexPermission(method, event),
          confirm: () => confirmCodexTurn(session, event.turnId),
          respond: (decision, resolved) => codex.respondPermission(requestId, decision, resolved),
        })
          .catch(() => console.error('Не удалось опубликовать запрос разрешения Codex в Telegram.'));
        outgoing = Promise.all([outgoing, publication]).then(() => {});
      }
      return;
    }
    if (method === 'thread/name/updated' && typeof event.threadName === 'string') {
      session.name = event.threadName;
    }
    if (method !== 'item/completed' || event.item?.type !== 'agentMessage' || typeof event.item.text !== 'string') {
      return;
    }
    outgoing = outgoing.then(async () => {
      if (!(await session.ready) || sessions.get(key) !== session) return;
      session.confirmed = true;
      await publish(session, event.item.text);
    }).catch(() => console.error('Не удалось опубликовать сообщение Codex в Telegram.'));
  }, () => {
    choices.clearThread(undefined);
    approvals.clear('Codex', undefined, { disconnected: true });
  }) : undefined;

  async function confirmCodexTurn(session, turnId) {
    try {
      // A replay on subscription supplies the current request, but the turn also needs to be live.
      await Promise.resolve();
      if (!await session.ready || !await codex.isLoaded(session.id)) return false;
      return await codex.activeTurnId(session.id) === turnId
        && !stopSignal.aborted && sessions.get(session.key) === session;
    } catch {
      return false;
    }
  }

  let openCode;
  let openCodeReady;
  let openCodeConnected = true;
  const openCodeRevisions = new Map();
  function clearOpenCodeSessions() {
    openCodeConnected = false;
    forms.close();
    approvals.clear('OpenCode', undefined, { disconnected: true });
    for (const [key, session] of sessions) {
      if (session.agent === 'OpenCode') sessions.delete(key);
    }
  }

  function onOpenCodeEvent(event) {
    const id = event.type === 'form.created' ? event.data?.form?.sessionID : event.data?.sessionID;
    if (!openCodeIds.has(id)) return;
    const key = `OpenCode:${id}`;
    if (event.type === 'permission.replied') {
      approvals.resolve(key, event.data.requestID);
      return;
    }
    if (event.type === 'form.replied' || event.type === 'form.cancelled') {
      forms.close(id, event.data.id);
      return;
    }
    if (event.type === 'session.deleted' || event.type === 'session.archived') {
      openCodeRevisions.set(key, Symbol());
      sessions.delete(key);
      forms.close(id);
      approvals.clear('OpenCode', id);
      return;
    }
    if (event.type === 'session.renamed') {
      const session = sessions.get(key);
      if (session && typeof event.data.title === 'string') session.name = event.data.title;
      return;
    }
    if (!['session.text.ended', 'session.viewed', 'session.execution.started', 'form.created', 'permission.asked']
      .includes(event.type)) return;
    const revision = openCodeRevisions.get(key);
    outgoing = outgoing.then(async () => {
      const connection = await openCodeReady;
      if (!connection) return;
      if (event.type === 'session.execution.started') {
        const active = await connection.active().catch(() => undefined);
        if (active?.[id]?.type !== 'running') return;
      }
      const session = await confirmOpenCodeSession(connection, id, revision);
      if (session && event.type === 'form.created') {
        await forms.publish(session, event.data.form.id, connection, () =>
          openCodeConnected && !stopSignal.aborted && sessions.get(key) === session);
      }
      if (session && event.type === 'permission.asked') {
        await publishOpenCodePermission(connection, session, event.data);
      }
      if (session && event.type === 'session.text.ended' && typeof event.data.text === 'string') {
        await publish(session, event.data.text);
      }
    }).catch(() => console.error('Не удалось опубликовать сообщение OpenCode в Telegram.'));
  }

  async function publishOpenCodePermission(connection, session, request) {
    const requestId = request.id;
    if (typeof requestId !== 'string' || !requestId.startsWith('per')) return;
    const { id, key } = session;
    const connected = () => openCodeConnected && !stopSignal.aborted && sessions.get(key) === session;
    // OpenCode 2.3.2 accepts a reused request ID and reply lacks an atomic comparison of the request.
    await approvals.publish({
      session, id: requestId, details: { description: openCodePermissionDescription(request) },
      confirm: async (isOpen) => {
        const current = await connection.readPermission(id, requestId).catch(() => undefined);
        return connected() && isOpen() && isDeepStrictEqual(current, request);
      },
    });
  }

  async function confirmOpenCodeSession(connection, id, revision) {
    const key = `OpenCode:${id}`;
    const data = await connection.read(id).catch(() => undefined);
    if (!openCodeConnected || openCodeRevisions.get(key) !== revision
      || data?.id !== id || !data.time || data.time.archived !== undefined) return;
    const session = sessions.get(key) ?? { agent: 'OpenCode', key, id, suffix: sessionSuffix(id, openCodeIds) };
    session.name = typeof data.title === 'string' ? data.title : '';
    session.confirmed = true;
    sessions.set(key, session);
    return session;
  }

  async function deliver(session, text) {
    if (!session?.confirmed || sessions.get(session.key) !== session) return 'unconfirmed';
    if (session.agent === 'OpenCode') {
      const result = await openCode.deliver(session.id, text);
      if (result === 'unconfirmed') session.confirmed = false;
      return result;
    }
    let thread;
    try {
      if (await codex.isLoaded(session.id)) thread = await codex.read(session.id);
    } catch {
      // Connection failed before there was an attempt to submit this text.
    }
    if (!isLiveThread(thread, session.id) || stopSignal.aborted || sessions.get(session.key) !== session) {
      return 'unconfirmed';
    }
    return codex.deliver(thread, text);
  }

  async function askForSession(message, staleReply = false, unavailableSession = undefined) {
    const choices = new Map([...sessions.values()]
      .filter((session) => session.confirmed && session !== unavailableSession)
      .map((session) => [randomUUID(), session]));
    const keyboard = [...choices].map(([callback_data, session]) => [{ text: sessionLabel(session, 40), callback_data }]);
    const instructions = 'Выберите сессию для этого текста.';
    const unavailable = deliveryStatus('unavailable', unavailableSession?.agent ?? defaultAgent);
    const text = choices.size ? (staleReply ? `${unavailable}\n${instructions}` : instructions) : unavailable;
    const prompt = await telegram.send(text, {
      replyTo: message.message_id,
      keyboard: choices.size ? keyboard : undefined,
    }).catch(() => console.error('Telegram не подтвердил отправку выбора сессии.'));
    if (choices.size && Number.isSafeInteger(prompt?.message_id) && prompt.message_id > 0) {
      drafts.set(prompt.message_id, {
        sourceId: message.message_id,
        text: message.text,
        choices,
        result: undefined,
      });
    }
  }

  async function chooseSession(query) {
    const promptId = query.message.message_id;
    const draft = drafts.get(promptId);
    const session = draft?.choices.get(query.data);
    const original = query.message.reply_to_message;
    const answer = (text) => telegram.answerCallback(query.id, text).catch(() => {});
    if (!session) {
      await answer('Этот выбор недоступен. Отправьте текст заново.');
      return;
    }
    // Telegram can omit the source reply after the delivery has already finished.
    if (draft.result) {
      await answer(draft.result === 'delivered' ? 'Текст уже принят сессией.' : deliveryStatus('unknown', session.agent));
      return;
    }
    if (!isOwnerMessage(original, profile) || original.message_id !== draft.sourceId || original.text !== draft.text) {
      await answer('Исходный текст недоступен или изменился. Отправьте его заново.');
      return;
    }
    await answer('Проверяю сессию…');
    const result = await deliver(session, draft.text);
    if (result === 'delivered' || result === 'unknown') {
      draft.result = result;
      draft.text = undefined;
      await telegram.editChoice(promptId, `${sessionLabel(session, 160)}\n\n${deliveryStatus(result, session.agent)}`)
        .catch(() => sendStatus(result, session.agent));
    } else {
      await sendStatus('unavailable', session.agent);
    }
  }

  function sendStatus(result, agent) {
    return telegram.send(deliveryStatus(result, agent)).catch(() => {
      console.error('Telegram не подтвердил отправку статуса ответа.');
    });
  }

  async function connectCodex() {
    if (!codex) return;
    await codex.initialize();
    for (const threadId of threadIds) {
      if (!await codex.isLoaded(threadId)) continue;
      const thread = await codex.read(threadId);
      if (!isLiveThread(thread, threadId)) continue;
      const session = {
        agent: 'Codex',
        key: `Codex:${threadId}`,
        id: threadId,
        name: typeof thread.name === 'string' ? thread.name : '',
        suffix: sessionSuffix(threadId, threadIds),
        ready: null,
        confirmed: false,
      };
      sessions.set(session.key, session);
      // Resume can hydrate history if the thread was unloaded after the check.
      // A new item event provides live evidence for replies and explicit selection.
      session.ready = codex.subscribe(threadId).then((resumed) => isLiveThread(resumed, threadId), () => false);
      if (!await session.ready) sessions.delete(session.key);
    }
  }

  try {
    if (openCodeIds.size) {
      openCodeReady = import('./opencode.mjs')
        .then(({ openOpenCode }) => openOpenCode(onOpenCodeEvent, clearOpenCodeSessions, stopSignal))
        .catch(() => undefined);
    }
    const codexReady = connectCodex();
    if (openCodeIds.size) await codexReady.catch(() => {});
    else await codexReady;
    openCode = await openCodeReady;
    const active = await openCode?.active().catch(() => undefined);
    for (const id of openCodeIds) {
      if (active?.[id]?.type === 'running') {
        await confirmOpenCodeSession(openCode, id, openCodeRevisions.get(`OpenCode:${id}`));
      }
      const key = `OpenCode:${id}`;
      const revision = openCodeRevisions.get(key);
      const pending = await openCode?.pendingForms(id).catch(() => undefined);
      const pendingApprovals = await openCode?.pendingPermissions(id).catch(() => undefined);
      if (!pending?.length && !pendingApprovals?.length) continue;
      const session = await confirmOpenCodeSession(openCode, id, revision);
      if (session) {
        for (const form of pending ?? []) {
          if (form.sessionID !== id) continue;
          await forms.publish(session, form.id, openCode, () =>
            openCodeConnected && !stopSignal.aborted && sessions.get(key) === session)
            .catch(() => console.error('Не удалось опубликовать форму OpenCode в Telegram.'));
        }
        for (const request of pendingApprovals ?? []) {
          if (request.sessionID !== id) continue;
          await publishOpenCodePermission(openCode, session, request)
            .catch(() => console.error('Не удалось опубликовать запрос разрешения OpenCode в Telegram.'));
        }
      }
    }
    if (!sessions.size && !openCode) {
      const reason = openCodeIds.size
        ? 'Ни один сервер не подтвердил подключение указанных сессий.'
        : 'Общий App Server не подтвердил ни одной указанной сессии Codex.';
      console.error(`Приём выключен. ${reason}`);
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
        if (update.callback_query) {
          if (!isOwnerCallback(update.callback_query, profile)) continue;
          if (await approvals.handle(update.callback_query)) continue;
          if (await choices.handle(update.callback_query, confirmCodexTurn, (id, result) => codex.respond(id, result))) continue;
          if (await forms.handle(update.callback_query)) continue;
          await chooseSession(update.callback_query);
          continue;
        }
        const message = update.message;
        if (!isOwnerMessage(message, profile) || typeof message.text !== 'string' || !message.text.trim()) continue;
        const reply = message.reply_to_message;
        await outgoing;
        if (!reply) {
          await askForSession(message);
          continue;
        }
        const session = reply.from?.id === profile.botId && reply.from.is_bot === true
          ? messageBindings.get(reply.message_id)
          : undefined;
        const result = await deliver(session, message.text);
        if (result === 'unconfirmed') await askForSession(message, true, session);
        else await sendStatus(result, session.agent);
      }
    }
    return 0;
  } finally {
    codex?.close();
    await openCode?.close();
  }
}

async function main(args) {
  const [command, ...ids] = args;
  const codexId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
  const openCodeId = /^opencode:ses_[a-zA-Z\d_-]{1,124}$/;
  if (command !== 'start' || !ids.length || ids.some((id) => !codexId.test(id) && !openCodeId.test(id))) {
    console.error('Запуск: node src/receiver.mjs start <идентификатор-сессии-Codex|opencode:идентификатор> [...]');
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
    const threadIds = new Set(ids.filter((id) => codexId.test(id)).map((id) => id.toLowerCase()));
    const openCodeIds = new Set(ids.filter((id) => openCodeId.test(id)).map((id) => id.slice('opencode:'.length)));
    return await runReceiver(telegram, profile, threadIds, openCodeIds, stop.signal);
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
