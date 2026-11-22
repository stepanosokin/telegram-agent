import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyProfileAccess } from './profile.mjs';
import { acquireLocalLock } from './local-lock.mjs';

const stateFiles = ['pause', 'availability', 'autostart', 'command.lock', 'receiver.lock', 'pause.lock'];
const reasons = ['manual', 'conflict'];

function missing(error) {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const file = await open(path, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

export async function openReceiverControl(profile) {
  const directory = join(profile, 'receiver-control-v1');
  const created = await mkdir(directory, { mode: 0o700 }).then(() => true, (error) => {
    if (error.code !== 'EEXIST') throw error;
    return false;
  });
  await verifyProfileAccess(directory, stateFiles, false, true);
  if (created) await syncDirectory(profile);
  const lockId = createHash('sha256').update(process.platform === 'win32' ? profile.toLowerCase() : profile)
    .digest('hex').slice(0, 32);
  const lock = (name, onLoss) => acquireLocalLock(join(directory, `${name}.lock`), onLoss);

  function read(name) {
    return readFile(join(directory, name), 'utf8').catch(missing);
  }

  async function write(name, value) {
    const path = join(directory, name);
    const temporary = join(directory, `.new-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(value);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      await syncDirectory(directory);
    } finally {
      await unlink(temporary).catch(missing);
    }
  }

  async function remove(name) {
    await unlink(join(directory, name)).catch(missing);
    await syncDirectory(directory);
  }

  async function pause() {
    const value = await read('pause');
    if (value === undefined) return;
    const reason = value.trim();
    if (!reasons.includes(reason)) throw new Error('Неизвестная причина паузы приёма.');
    return reason;
  }

  async function watchStop(stop, automaticSettings) {
    while (!stop.signal.aborted) {
      await delay(250, undefined, { signal: stop.signal }).catch((error) => {
        if (!stop.signal.aborted) throw error;
      });
      if (!stop.signal.aborted && (await pause() || (automaticSettings && automaticSettings !== await read('autostart')))) stop.abort();
    }
  }

  async function withLock(name, operation, signal) {
    for (let attempt = 0; attempt < 120 && !signal?.aborted; attempt++) {
      const unlock = await lock(name);
      if (unlock) {
        try { return await operation(); } finally { await unlock(); }
      }
      await delay(100, undefined, { signal }).catch((error) => { if (!signal?.aborted) throw error; });
    }
    if (signal?.aborted) return;
    throw new Error('Управление получателем занято.');
  }

  async function status() {
    const unlock = await lock('receiver');
    await unlock?.();
    const [reason, agents] = await Promise.all([pause(), read('availability')]);
    return { reason, running: !unlock, agents: agents ? JSON.parse(agents) : undefined };
  }

  return {
    pause, status, watchStop, directory,
    withCommand: (operation, signal) => withLock('command', operation, signal),
    fileId: lockId,
    lockReceiver: (onLoss) => lock('receiver', onLoss),
    setPause: (reason) => withLock('pause', async () => {
      if (await pause()) return false;
      await write('pause', `${reason}\n`);
      return true;
    }),
    clearPause: () => remove('pause'),
    availability: (agents) => write('availability', JSON.stringify(agents)),
    autostart: () => read('autostart'),
    saveAutostart: (settings) => write('autostart', settings),
    clearAutostart: () => remove('autostart'),
  };
}
