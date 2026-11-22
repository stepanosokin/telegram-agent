import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { openAppServer } from './codex.mjs';
import { codexChoices } from './codex-choices.mjs';
import { openCodeForms } from './opencode-forms.mjs';
import { codexPermission, openCodePermissionDescription, permissions } from './permissions.mjs';
import { readProfile } from './profile.mjs';
import { openTextState } from './text-state.mjs';
import { isOwnerCallback, isOwnerMessage, telegramClient, TelegramError } from './telegram.mjs';

function deliveryStatus(result, agent) {
  if (result === 'delivered') return `${agent} принял ваш ответ.`;
  if (result === 'unknown') return `${agent} не подтвердил результат. Проверьте историю и очередь сессии на компьютере перед повтором.`;
  return `Ответ не доставлен. Проверьте исходную сессию${agent ? ' ' + agent : ''} на компьютере.`;
}

function attemptStatus(result, agent) {
  if (result === 'delivered' && !agent) return 'Текст уже принят сессией.';
  if (result === 'unknown' && !agent) return 'Результат неизвестен. Проверьте историю и очередь сессии перед повтором.';
  const status = deliveryStatus(result, agent);
  return ['unavailable', 'received'].includes(result) ? `${status} Чтобы попробовать снова, отправьте текст новым сообщением.` : status;
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

async function runReceiver(telegram, profile, textState, threadIds, openCodeIds, stopSignal) {
  const sessions = new Map();
  const drafts = new Map();
  const defaultAgent = !openCodeIds.size ? 'Codex' : !threadIds.size ? 'OpenCode' : undefined;
  let outgoing = Promise.resolve();
  const choices = codexChoices(telegram, (session) => sessionLabel(session, 160));
  const forms = openCodeForms(telegram, (session) => sessionLabel(session, 160));
  const approvals = permissions(telegram, (session) => sessionLabel(session, 160), bindMessage);

  async function bindMessage(session, published) {
    if (sessions.get(session.key) === session && Number.isSafeInteger(published?.message_id) && published.message_id > 0) {
      await textState.bind(published.message_id, session.key, session.serverInstance);
      session.confirmed = true;
    }
  }

  async function publish(session, body) {
    if (!body.trim()) return;
    const header = `${sessionLabel(session, 160)}\n\n`;
    for (const text of withHeader(header, body)) {
      await bindMessage(session, await telegram.send(text));
    }
  }

  /** @type {ReturnType<typeof openAppServer> | undefined} */
  let codex;
  function onCodexEvent(method, event, requestId) {
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
      if (typeof event.turn?.id === 'string') session.confirmed = true;
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
  }

  function clearCodexSessions() {
    codex = undefined;
    choices.clearThread(undefined);
    approvals.clear('Codex', undefined, { disconnected: true });
    for (const [key, session] of sessions) {
      if (session.agent === 'Codex') sessions.delete(key);
    }
  }

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

  /** @type {Awaited<ReturnType<typeof import('./opencode.mjs').openOpenCode>>} */
  let openCode;
  let openCodeReady;
  let openCodeGeneration;
  const openCodeRevisions = new Map();
  function clearOpenCodeSessions() {
    openCodeGeneration = undefined;
    openCode = undefined;
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
      const { requestID } = event.data;
      approvals.resolve(key, requestID);
      // Clear the old notification after publications queued before this event.
      // OpenCode can open a distinct request with the same ID afterwards.
      outgoing = outgoing.then(() => approvals.forgetNotification(key, requestID));
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
    const connectionReady = openCodeReady;
    outgoing = outgoing.then(async () => {
      const connection = await connectionReady;
      if (!connection || openCode !== connection) return;
      if (event.type === 'session.execution.started') {
        const active = await connection.active().catch(() => undefined);
        if (active?.[id]?.type !== 'running') return;
      }
      const session = await confirmOpenCodeSession(connection, id, revision, { verifyReplyable: event.type === 'session.viewed' });
      if (session && event.type === 'form.created') {
        await forms.publish(session, event.data.form.id, connection, () =>
          openCode === connection && !stopSignal.aborted && sessions.get(key) === session);
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
    const connected = () => openCode === connection && !stopSignal.aborted && sessions.get(key) === session;
    // OpenCode 2.3.2 accepts a reused request ID and reply lacks an atomic comparison of the request.
    await approvals.publish({
      session, id: requestId, details: { description: openCodePermissionDescription(request) },
      confirm: async (isOpen) => {
        const current = await connection.readPermission(id, requestId).catch(() => undefined);
        return connected() && isOpen() && isDeepStrictEqual(current, request);
      },
    });
  }

  async function confirmOpenCodeSession(connection, id, revision, { verifyReplyable = false, requireActive = false } = {}) {
    const key = `OpenCode:${id}`;
    // Viewing a dialog can load history without taking ownership of a running turn.
    const lookup = verifyReplyable ? connection.readReplyableSession(id, requireActive) : connection.read(id);
    const data = await lookup.catch(() => undefined);
    if (openCode !== connection || openCodeRevisions.get(key) !== revision) return;
    if (data?.id !== id || !data.time || data.time.archived !== undefined) {
      const session = sessions.get(key);
      if (verifyReplyable && session) session.confirmed = false;
      return;
    }
    const session = sessions.get(key) ?? {
      agent: 'OpenCode', key, id, suffix: sessionSuffix(id, openCodeIds), serverInstance: connection.instance,
    };
    session.name = typeof data.title === 'string' ? data.title : '';
    session.confirmed = true;
    sessions.set(key, session);
    return session;
  }

  async function deliver(session, messageId, text) {
    if (!session?.confirmed || sessions.get(session.key) !== session) return 'unconfirmed';
    const submit = (send) => textState.submit(messageId, session.agent, () =>
      stopSignal.aborted || sessions.get(session.key) !== session ? 'unavailable' : send());
    if (session.agent === 'OpenCode') {
      const result = await openCode.deliver(session.id, text, submit);
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
    return codex.deliver(thread, text, submit);
  }

  async function restoreReply(reply) {
    if (reply.from?.id !== profile.botId || reply.from.is_bot !== true
      || !Number.isSafeInteger(reply.message_id) || reply.message_id <= 0) return;
    const binding = await textState.binding(reply.message_id);
    if (!binding) return;
    if (binding.key.startsWith('Codex:')) {
      const id = binding.key.slice('Codex:'.length);
      if (!threadIds.has(id)) return;
      try {
        const connection = await connectCodex();
        const session = sessions.get(binding.key) ?? await attachCodexSession(connection, id);
        // Resume can load history itself, so only an independent live event qualifies.
        await outgoing;
        if (session?.confirmed) return session;
      } catch {
        // A disconnected server or stored history supplies no live routing evidence.
      }
      return;
    }
    const id = binding.key.slice('OpenCode:'.length);
    if (!openCodeIds.has(id)) return;
    const connection = await connectOpenCode();
    await outgoing;
    const known = sessions.get(binding.key);
    if (known?.confirmed) return known;
    if (connection) {
      return confirmOpenCodeSession(connection, id, openCodeRevisions.get(binding.key), {
        verifyReplyable: true,
        requireActive: binding.serverInstance !== connection.instance,
      });
    }
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
      const previous = !draft && isOwnerMessage(original, profile) && await textState.attempt(original.message_id);
      const text = previous ? attemptStatus(previous.result, previous.agent)
        : 'Этот выбор недоступен. Если уже отправляли текст в сессию, проверьте её историю и очередь перед повтором.';
      await answer(text);
      return;
    }
    // Telegram can omit the source reply after the delivery has already finished.
    if (draft.result) {
      await answer(draft.result === 'delivered' ? 'Текст уже принят сессией.' : attemptStatus(draft.result, session.agent));
      return;
    }
    if (!isOwnerMessage(original, profile) || original.message_id !== draft.sourceId || original.text !== draft.text) {
      await answer('Исходный текст недоступен или изменился. Отправьте его заново.');
      return;
    }
    await answer('Проверяю сессию…');
    const result = await deliver(session, draft.sourceId, draft.text);
    if (result !== 'unconfirmed') {
      draft.result = result;
      draft.text = undefined;
      await telegram.editChoice(promptId, `${sessionLabel(session, 160)}\n\n${attemptStatus(result, session.agent)}`)
        .catch(() => sendStatus(result, session.agent));
    } else {
      await sendStatus('unavailable', session.agent);
    }
  }

  function sendStatus(result, agent) {
    return telegram.send(attemptStatus(result, agent)).catch(() => {
      console.error('Telegram не подтвердил отправку статуса ответа.');
    });
  }

  async function connectCodex() {
    if (codex) return codex;
    if (!threadIds.size || stopSignal.aborted) return;
    const connection = openAppServer(onCodexEvent, clearCodexSessions);
    codex = connection;
    try {
      await connection.initialize();
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async function attachCodexSession(connection, threadId) {
    if (!connection || !await connection.isLoaded(threadId)) return;
    const thread = await connection.read(threadId);
    if (!isLiveThread(thread, threadId) || codex !== connection) return;
    const session = {
      agent: 'Codex', key: `Codex:${threadId}`, id: threadId,
      name: typeof thread.name === 'string' ? thread.name : '',
      suffix: sessionSuffix(threadId, threadIds), ready: null, confirmed: false,
    };
    sessions.set(session.key, session);
    // Resume can hydrate history if the thread was unloaded after the check.
    // A new item event provides live evidence for explicit selection.
    session.ready = connection.subscribe(threadId).then((resumed) => isLiveThread(resumed, threadId), () => false);
    if (await session.ready && sessions.get(session.key) === session) return session;
    if (sessions.get(session.key) === session) sessions.delete(session.key);
  }

  async function connectOpenCode() {
    if (!openCodeIds.size || stopSignal.aborted) return;
    const previous = openCode;
    if (previous && await previous.currentServer().catch(() => false)) return previous;
    await previous?.close();
    const generation = Symbol();
    openCodeGeneration = generation;
    const current = () => openCodeGeneration === generation;
    openCodeReady = import('./opencode.mjs')
      .then(({ openOpenCode }) => openOpenCode(
        (event) => { if (current()) onOpenCodeEvent(event); },
        () => { if (current()) clearOpenCodeSessions(); },
        stopSignal,
      ))
      .then((connection) => {
        if (current()) openCode = connection;
        return connection;
      })
      .catch(() => undefined);
    return openCodeReady;
  }

  try {
    const sessionKeys = new Set([
      ...[...threadIds].map((id) => `Codex:${id}`),
      ...[...openCodeIds].map((id) => `OpenCode:${id}`),
    ]);
    const mayRestore = await textState.hasBinding(sessionKeys);
    const openCodeStarting = connectOpenCode();
    const codexReady = (async () => {
      const connection = await connectCodex();
      for (const threadId of threadIds) await attachCodexSession(connection, threadId);
    })();
    if (openCodeIds.size || mayRestore) {
      await codexReady.catch(() => {});
    } else {
      await codexReady;
    }
    const openCodeStartingConnection = await openCodeStarting;
    const active = await openCodeStartingConnection?.active().catch(() => undefined);
    for (const id of openCodeIds) {
      if (active?.[id]?.type === 'running') {
        await confirmOpenCodeSession(openCodeStartingConnection, id, openCodeRevisions.get(`OpenCode:${id}`));
      }
      const key = `OpenCode:${id}`;
      const revision = openCodeRevisions.get(key);
      const pending = await openCodeStartingConnection?.pendingForms(id).catch(() => undefined);
      const pendingApprovals = await openCodeStartingConnection?.pendingPermissions(id).catch(() => undefined);
      if (!pending?.length && !pendingApprovals?.length) continue;
      const session = await confirmOpenCodeSession(openCodeStartingConnection, id, revision);
      if (session) {
        for (const form of pending ?? []) {
          if (form.sessionID !== id) continue;
          await forms.publish(session, form.id, openCodeStartingConnection, () =>
            openCode === openCodeStartingConnection && !stopSignal.aborted && sessions.get(key) === session)
            .catch(() => console.error('Не удалось опубликовать форму OpenCode в Telegram.'));
        }
        for (const request of pendingApprovals ?? []) {
          if (request.sessionID !== id) continue;
          outgoing = outgoing.then(() => publishOpenCodePermission(openCodeStartingConnection, session, request))
            .catch(() => console.error('Не удалось опубликовать запрос разрешения OpenCode в Telegram.'));
          await outgoing;
        }
      }
    }
    if (!sessions.size && !openCode && !mayRestore) {
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
        if (!await textState.claim(message.message_id)) {
          const previous = await textState.attempt(message.message_id);
          await sendStatus(previous?.result ?? 'unknown', previous?.agent);
          continue;
        }
        const reply = message.reply_to_message;
        await outgoing;
        if (!reply) {
          await askForSession(message);
          continue;
        }
        const session = await restoreReply(reply);
        const result = await deliver(session, message.message_id, message.text);
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
    let textState;
    try {
      textState = await openTextState(profile);
    } catch {
      console.error('Приём выключен. Проверьте каталог и права доступа к состоянию восстановления в ~/.telegram.');
      return 1;
    }
    const threadIds = new Set(ids.filter((id) => codexId.test(id)).map((id) => id.toLowerCase()));
    const openCodeIds = new Set(ids.filter((id) => openCodeId.test(id)).map((id) => id.slice('opencode:'.length)));
    return await runReceiver(telegram, profile, textState, threadIds, openCodeIds, stop.signal);
  } catch (error) {
    if (stop.signal.aborted) return 0;
    const reason = error instanceof TelegramError
      ? (error.code === 409 ? 'Конфликт получателей Telegram.' : 'Ошибка связи с Telegram.')
      : (error?.code ? 'Ошибка доступа к локальному состоянию.' : 'Ошибка связи с общим App Server Codex.');
    console.error(`Приём выключен. ${reason}`);
    return 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

process.exitCode = await main(process.argv.slice(2));
