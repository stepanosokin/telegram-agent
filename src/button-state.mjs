import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyProfileAccess } from './profile.mjs';

const reconnected = 'Связь восстановлена. Нажмите кнопку снова.';
const unavailable = 'Запрос не подтверждён. Проверьте исходную сессию на компьютере.';
const unknown = 'Результат ответа не подтверждён. Проверьте исходную сессию на компьютере.';
const statuses = new Map([
  ['sending', unknown], ['unknown', unknown],
  ['closed', 'Запрос закрыт. Итог виден в исходной сессии.'],
  ['sent', 'Ответ отправлен. Итог виден в исходной сессии.'],
  ['accepted', 'OpenCode принял ответ.'],
  ['unavailable', unavailable],
]);
const possiblyAnswered = new Set(['sending', 'unknown', 'sent', 'accepted']);

function digest(value) {
  // SDK and App Server object property order need not be the same after subscription.
  return createHash('sha256').update(JSON.stringify(value, (key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : item)).digest('hex');
}

const validId = (id) => (typeof id === 'string' && id.length > 0 && id.length <= 512) || Number.isSafeInteger(id);
const kindAgent = (kind) => kind === 'form' ? 'OpenCode' : 'Codex';

function parseRecord(raw) {
  try {
    const [binding, ...lines] = raw.split('\n');
    const request = JSON.parse(binding);
    if (!request || !['form', 'codex', 'permission'].includes(request.kind)
      || typeof request.sessionKey !== 'string' || !request.sessionKey.startsWith(kindAgent(request.kind) + ':')
      || typeof request.instance !== 'string' || !/^[a-f0-9-]{36,64}$/.test(request.instance)
      || !validId(request.requestId) || (request.kind === 'form' && typeof request.requestId !== 'string')
      || (request.turnId !== undefined && !validId(request.turnId)) || !/^[a-f0-9]{64}$/.test(request.digest)) return;
    const complete = lines.pop() === '';
    const displayed = lines.at(-1) === 'displayed';
    if (displayed) lines.pop();
    const valid = complete && lines.every((line) => statuses.has(line));
    return { binding, request, status: valid ? lines.at(-1) ?? 'pending' : 'unknown',
      displayed: valid && displayed, live: undefined };
  } catch {
    // A partially written bind was never actionable.
  }
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function openButtonState(profile, telegram) {
  const name = ['receiver-buttons-v1', profile.botId, profile.chatId, profile.ownerId].join('-');
  const directory = join(profile.directory, name);
  const created = await mkdir(directory, { mode: 0o700 }).then(() => true, (error) => {
    if (error.code !== 'EEXIST') throw error;
    return false;
  });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Привязки кнопок требуют отдельный каталог.');
  const names = await readdir(directory);
  if (names.some((name) => !/^[1-9]\d*$/.test(name))) throw new Error('Неизвестный файл привязок кнопок.');
  await verifyProfileAccess(directory, names, true);
  if (created) await syncDirectory(profile.directory);
  const records = new Map();
  const byBinding = new Map();
  const locks = new Map();
  const generation = new Map();
  for (const name of names) {
    const id = Number(name);
    const record = parseRecord(await readFile(join(directory, name), 'utf8'));
    if (!Number.isSafeInteger(id) || !record) continue;
    records.set(id, record);
    byBinding.set(record.binding, byBinding.has(record.binding) ? null : id);
  }

  async function serialize(binding, run) {
    const pending = (locks.get(binding) ?? Promise.resolve()).catch(() => {}).then(run);
    locks.set(binding, pending);
    try { return await pending; } finally {
      if (locks.get(binding) === pending) locks.delete(binding);
    }
  }

  async function writeLine(id, value, flags) {
    const file = await open(join(directory, String(id)), flags, 0o600);
    try {
      await file.writeFile(value + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async function append(id, record, status) {
    record.status = status === 'sending' ? 'unknown' : status;
    await writeLine(id, status, 'a');
    record.status = status;
  }

  async function markDisplayed(id, record, render) {
    if (!await render()) return false;
    await writeLine(id, 'displayed', 'a');
    record.displayed = true;
    return true;
  }

  function sameRequest(a, b) {
    return a.kind === b.kind && a.sessionKey === b.sessionKey && a.requestId === b.requestId && a.digest === b.digest;
  }

  function openGeneration(agent) {
    const current = generation.get(agent);
    return () => current === generation.get(agent);
  }

  return {
    async publish(kind, session, requestId, context, text, keyboard, isCurrent = () => true, turnId = undefined) {
      const { key: sessionKey, serverInstance: instance } = session;
      const request = { kind, sessionKey, instance, requestId, turnId, digest: digest(context) };
      const binding = JSON.stringify(request);
      const currentGeneration = openGeneration(kindAgent(kind));
      const current = () => currentGeneration() && isCurrent();
      return serialize(binding, async () => {
        if (!current()) return;
        const match = byBinding.get(binding);
        if (match !== undefined) {
          if (match === null) return;
          const record = records.get(match);
          if (record.status !== 'pending' || record.live) return;
          const updatedText = text.length + reconnected.length + 2 <= 4096 ? text + '\n\n' + reconnected : text;
          try {
            await telegram.editChoice(match, updatedText, keyboard);
          } catch (error) {
            if (![400, 403, 404].includes(error?.code)) throw error;
            await append(match, record, 'unavailable');
            // This Telegram message cannot be edited. Its callback remains disabled.
            await writeLine(match, 'displayed', 'a');
            record.displayed = true;
            return;
          }
          if (!current()) return;
          record.live = 'restored';
          return { message_id: match };
        }
        // The old attempt may still have reached the same request after a server replacement.
        if ([...records.values()].some((record) => possiblyAnswered.has(record.status) && sameRequest(request, record.request))) return;
        const message = await telegram.send(text, { keyboard });
        const id = message?.message_id;
        if (!Number.isSafeInteger(id) || id <= 0 || records.has(id)) return;
        await writeLine(id, binding, 'wx');
        await syncDirectory(directory);
        const record = { binding, request, status: 'pending', displayed: false, live: undefined };
        records.set(id, record);
        byBinding.set(binding, id);
        if (!current()) return;
        record.live = 'new';
        return message;
      });
    },
    begin(id) {
      const record = records.get(id);
      if (!record) return false;
      return serialize(record.binding, async () => {
        if (record.status !== 'pending' || !record.live) return false;
        await append(id, record, 'sending');
        return true;
      });
    },
    async complete(id, status, render) {
      const record = records.get(id);
      if (!record) return;
      await serialize(record.binding, async () => {
        record.live = undefined;
        await append(id, record, status).catch(() => console.error('Не удалось сохранить итог запроса в локальном профиле.'));
        await markDisplayed(id, record, render).catch(() => {});
      });
    },
    async resolved(sessionKey, instance, requestId) {
      for (const [id, record] of records) {
        const request = record.request;
        if (request.sessionKey !== sessionKey || request.instance !== instance || request.requestId !== requestId) continue;
        // Live handlers publish their own status and an in-flight response keeps its unknown outcome.
        await serialize(record.binding, async () => {
          if (!record.live && record.status === 'pending') await append(id, record, 'closed');
        }).catch(() => console.error('Не удалось сохранить закрытие запроса Codex.'));
      }
    },
    suspend(agent) {
      generation.set(agent, Symbol());
      for (const record of records.values()) {
        if (kindAgent(record.request.kind) === agent) record.live = undefined;
      }
    },
    callbackStatus(id, kind) {
      const record = records.get(id);
      if (record?.request.kind !== kind) return;
      return statuses.get(record.status) ?? (record.live === 'restored' ? reconnected : record.live ? undefined : unavailable);
    },
    hasBinding(sessionKeys) {
      return [...records.values()].some(({ request }) => sessionKeys.has(request.sessionKey));
    },
    hasUndisplayedStatus() {
      return [...records.values()].some((record) => record.status !== 'pending' && !record.displayed);
    },
    async reconcile(sessionKeys, statusFor) {
      let retry = false;
      for (const [id, record] of records) {
        if (!sessionKeys.has(record.request.sessionKey) || record.live || record.displayed) continue;
        await serialize(record.binding, async () => {
          if (record.live || record.displayed) return;
          const current = openGeneration(kindAgent(record.request.kind));
          const status = record.status === 'pending' ? await statusFor(record.request) : record.status;
          if (!current()) return;
          if (status === null) return;
          if (status === undefined) {
            await telegram.editChoice(id, unavailable).catch(() => {});
            return;
          }
          if (record.status !== status) await append(id, record, status);
          const displayed = await markDisplayed(id, record, () =>
            telegram.editChoice(id, statuses.get(status)).then(() => true, () => false));
          if (!displayed) retry = true;
        }).catch(() => { retry = true; });
      }
      return retry;
    },
  };
}
