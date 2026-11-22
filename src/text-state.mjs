import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyProfileAccess } from './profile.mjs';

const boundSession = /^(?:Codex:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|OpenCode:ses_[a-zA-Z\d_-]{1,124} [a-f\d]{64})\n$/;
const terminal = new Set(['delivered', 'unavailable']);

function parseBinding(value) {
  if (!value || !boundSession.test(value)) return;
  const [key, serverInstance] = value.trimEnd().split(' ');
  return { key, serverInstance };
}

async function readRecord(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function openTextState(profile) {
  const directory = join(profile.directory, `receiver-text-v1-${profile.botId}-${profile.chatId}-${profile.ownerId}`);
  const created = await mkdir(directory, { mode: 0o700 }).then(() => true, (error) => {
    if (error.code !== 'EEXIST') throw error;
    return false;
  });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Состояние восстановления должно быть отдельным каталогом.');
  const names = await readdir(directory);
  if (names.some((name) => !/^(?:binding|attempt)-[1-9]\d*$/.test(name))) {
    throw new Error('В каталоге восстановления найден неизвестный файл.');
  }
  await verifyProfileAccess(directory, names, true);

  async function syncDirectory(path) {
    if (process.platform === 'win32') return;
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  if (created) await syncDirectory(profile.directory);

  async function createRecord(path, value) {
    let file;
    try {
      file = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') return;
      throw error;
    }
    try {
      await file.writeFile(value + '\n');
      await file.sync();
      await syncDirectory(directory);
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async function attempt(messageId) {
    const value = await readRecord(join(directory, `attempt-${messageId}`));
    if (value === undefined) return;
    if (value === 'received\n') return { agent: undefined, result: 'received' };
    const [, agent, result] = value.split('\n');
    const knownAgent = ['Codex', 'OpenCode'].includes(agent);
    return {
      agent: knownAgent ? agent : undefined,
      result: knownAgent && value === `received\n${agent}\n${result}\n` && terminal.has(result) ? result : 'unknown',
    };
  }

  return {
    async bind(messageId, key, serverInstance) {
      const path = join(directory, `binding-${messageId}`);
      const value = serverInstance ? `${key} ${serverInstance}` : key;
      const file = await createRecord(path, value);
      if (file) await file.close();
      else if (await readRecord(path) !== `${value}\n`) throw new Error('Telegram вернул уже привязанный ID сообщения.');
    },
    async binding(messageId) {
      return parseBinding(await readRecord(join(directory, `binding-${messageId}`)));
    },
    async hasBinding(sessionKeys) {
      for (const name of names) {
        if (!name.startsWith('binding-')) continue;
        const binding = parseBinding(await readRecord(join(directory, name)));
        if (binding && sessionKeys.has(binding.key)) return true;
      }
      return false;
    },
    async claim(messageId) {
      const file = await createRecord(join(directory, `attempt-${messageId}`), 'received');
      if (!file) return false;
      await file.close();
      return true;
    },
    attempt,
    async submit(messageId, agent, send) {
      const previous = await attempt(messageId);
      if (previous?.result !== 'received') return previous?.result ?? 'unknown';
      const path = join(directory, `attempt-${messageId}`);
      const file = await open(path, 'a');
      try {
        await file.writeFile(agent + '\n');
        await file.sync();
        const result = await send();
        if (terminal.has(result)) {
          await file.writeFile(result + '\n');
          await file.sync();
        }
        return result;
      } finally {
        await file.close();
      }
    },
  };
}
