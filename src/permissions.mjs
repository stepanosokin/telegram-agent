import { randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';

const prefix = 'permission:';
const unavailable = 'Разрешение недоступно. Проверьте исходную сессию на компьютере.';
const closed = 'Запрос уже закрыт. Проверьте решение в исходной сессии.';
const unknown = 'Результат отправки не подтверждён. Проверьте исходную сессию на компьютере.';
const labels = { allow: 'Разрешить один раз', deny: 'Отклонить' };
const localOnly = 'Для этого запроса разрешения нужен ответ на компьютере.';

function displayable(text) {
  return typeof text === 'string' && text.trim() && !/[\p{C}\p{Zl}\p{Zp}]/u.test(text);
}

function absolutePath(path) {
  return displayable(path) && (posix.isAbsolute(path) || (win32.isAbsolute(path) && /^(?:[a-z]:|\\\\)/i.test(path)));
}

export function codexPermission(method, params) {
  if (method !== 'item/commandExecution/requestApproval' || !displayable(params.itemId)
    || !displayable(params.command) || !absolutePath(params.cwd)
    || (params.kind != null && params.kind !== 'command') || params.approvalId != null
    || params.additionalPermissions != null || params.networkApprovalContext != null) return;
  if (params.environmentId != null && !displayable(params.environmentId)) return;
  if (params.reason != null && !displayable(params.reason)) return;
  const available = params.availableDecisions;
  if (!Array.isArray(available)) return;
  const actions = {
    allow: available.includes('accept') ? 'accept' : undefined,
    deny: available.includes('decline') ? 'decline' : undefined,
  };
  const environment = params.environmentId == null ? '' : `\nСреда Codex: ${params.environmentId}`;
  const reason = params.reason == null ? '' : `\nПричина по данным Codex: ${params.reason}`;
  return {
    description: `Запуск команды\nКоманда: ${params.command}\nРабочий каталог: ${params.cwd}${environment}${reason}`,
    actions,
  };
}

export function openCodePermissionDescription(request) {
  if (!['read', 'edit', 'write'].includes(request.action) || !Array.isArray(request.resources)
    || !request.resources.length || !request.resources.every((resource) =>
      absolutePath(resource) && !/[*?\[\]{}]/.test(resource))) return;
  return `Действие: ${request.action}\nПути:\n${request.resources.map((path) => '• ' + path).join('\n')}`;
}

export function permissions(telegram, label, bindMessage) {
  const requests = new Map();
  const seen = new Set();
  const messages = new Map();
  const publications = new Map();
  const keyFor = (sessionKey, id) => JSON.stringify([sessionKey, id]);

  async function edit(entry, status) {
    if (!entry.messageId || !entry.buttons?.size) return;
    messages.set(entry.messageId, { tokens: new Set(entry.buttons.keys()), status });
    await telegram.editChoice(entry.messageId, `${entry.body}\n\n${status}`).catch(() => {});
  }

  function settle(entry, status) {
    entry.status = status;
    requests.delete(entry.key);
    return edit(entry, status);
  }

  function close(entry, status = closed) {
    if (entry.status) return;
    entry.finishSignal.resolve(status === closed);
    if (entry.sending) return;
    void settle(entry, status);
  }

  return {
    async publish({ session, id, turnId = undefined, details, confirm, respond = undefined }) {
      const key = keyFor(session.key, id);
      if (seen.has(key)) return;
      seen.add(key);
      const header = `${label(session)}\n\nЗапрос разрешения`;
      const body = `${header}\n${details?.description ?? ''}`;
      const entry = { key, session, turnId, body, finishSignal: Promise.withResolvers(),
        status: undefined, sending: false, messageId: undefined, buttons: new Map(), confirm, respond };
      requests.set(key, entry);
      const isOpen = () => !entry.status && requests.get(key) === entry;
      if (!await confirm(isOpen) || !isOpen()) {
        requests.delete(key);
        return;
      }
      if (respond && details?.actions && body.length <= 3800) {
        for (const [action, value] of Object.entries(details.actions)) {
          if (value) entry.buttons.set(prefix + randomUUID(), { action, value });
        }
      }
      if (!entry.buttons.size) {
        requests.delete(key);
        const context = details?.description && body.length <= 3800 ? body : header;
        bindMessage(session, await telegram.send(`${context}\n\n${localOnly}`));
        return;
      }
      const keyboard = [...entry.buttons].map(([callback_data, { action }]) =>
        [{ text: labels[action], callback_data }]);
      const published = telegram.send(body, { keyboard }).then(async (message) => {
        if (!Number.isSafeInteger(message?.message_id) || message.message_id <= 0) return;
        bindMessage(session, message);
        entry.messageId = message.message_id;
        messages.set(entry.messageId, { entry });
        if (entry.status) await edit(entry, entry.status);
      });
      for (const token of entry.buttons.keys()) publications.set(token, published);
      try {
        await published;
      } finally {
        for (const token of entry.buttons.keys()) publications.delete(token);
        if (!entry.messageId) requests.delete(key);
      }
    },
    async handle(query) {
      if (!query.data.startsWith(prefix)) return false;
      const answer = (text) => telegram.answerCallback(query.id, text).catch(() => {});
      await publications.get(query.data)?.catch(() => {});
      const prompt = messages.get(query.message.message_id);
      const entry = prompt?.entry;
      const choice = entry?.buttons.get(query.data);
      if (!choice) {
        await answer(prompt?.tokens?.has(query.data) ? prompt.status : unavailable);
        return true;
      }
      const isOpen = () => !entry.status && requests.get(entry.key) === entry;
      if (!isOpen() || entry.sending || !await entry.confirm(isOpen) || !isOpen() || entry.sending) {
        await answer(entry.status ?? unavailable);
        return true;
      }
      entry.sending = true;
      const result = await entry.respond(choice.value, entry.finishSignal.promise).catch(() => 'unknown');
      const status = result === 'sent'
        ? 'Решение отправлено, Codex закрыл запрос. Итог виден в исходной сессии.' : unknown;
      await settle(entry, status);
      await answer(status);
      return true;
    },
    resolve(sessionKey, id) {
      const entry = requests.get(keyFor(sessionKey, id));
      if (entry) close(entry);
    },
    /** @param {{matches?: (turnId: string | undefined) => boolean, disconnected?: boolean}} [options] */
    clear(agent, sessionId, options = {}) {
      const { matches = () => true, disconnected = false } = options;
      for (const [key, entry] of requests) {
        if (entry.session.agent !== agent || (sessionId !== undefined && entry.session.id !== sessionId)
          || !matches(entry.turnId)) continue;
        requests.delete(key);
        close(entry, disconnected ? unavailable : closed);
      }
    },
  };
}
