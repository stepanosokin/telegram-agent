import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { configureAutostart, ownerLoggedIn, restoreStartupEnvironment, startupSettings } from './autostart.mjs';
import { profileDirectory } from './profile.mjs';
import { openReceiverControl } from './receiver-control.mjs';

export const codexId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export const openCodeId = /^opencode:ses_[a-zA-Z\d_-]{1,124}$/;
const validIds = (ids) => ids.length > 0 && ids.every((id) => typeof id === 'string' && (codexId.test(id) || openCodeId.test(id)));

async function start(directory, control, ids, stop, receive) {
  const explicit = Boolean(ids);
  let automaticSettings;
  const release = await control.withCommand(async () => {
    if (stop.signal.aborted) return;
    if (!explicit) {
      if (await control.pause()) return;
      automaticSettings = await control.autostart();
      if (!automaticSettings) return;
      const settings = JSON.parse(automaticSettings);
      if (!Array.isArray(settings.ids) || !validIds(settings.ids)) throw new Error('Некорректные настройки автозапуска.');
      ids = settings.ids;
      restoreStartupEnvironment(settings, directory);
    }
    const unlock = await control.lockReceiver(() => stop.abort());
    if (!unlock) {
      if (explicit) console.error('Получатель обновлений Telegram уже запущен.');
      return;
    }
    try {
      if (explicit) await control.clearPause();
      await control.availability({
        Codex: ids.some((id) => codexId.test(id)) ? 'подключается' : 'не настроен',
        OpenCode: ids.some((id) => openCodeId.test(id)) ? 'подключается' : 'не настроен',
      });
      return unlock;
    } catch (error) {
      await unlock();
      throw error;
    }
  }, stop.signal);
  if (!release) return explicit ? 1 : 0;
  const pauseWatcher = control.watchStop(stop, automaticSettings).catch(() => stop.abort());
  try {
    return await receive(directory, control, ids, stop);
  } finally {
    stop.abort();
    await pauseWatcher;
    await release();
  }
}

async function stopReceiver(control) {
  return control.withCommand(async () => {
    await control.setPause('manual');
    const deadline = Date.now() + 12_000;
    do {
      const release = await control.lockReceiver();
      if (release) {
        await release();
        console.log('Приём Telegram остановлен. Пауза сохраняется до явного запуска.');
        return 0;
      }
      await delay(100);
    } while (Date.now() < deadline);
    console.error('Пауза сохранена. Получатель ещё завершает работу, проверьте статус перед переносом.');
    return 1;
  });
}

async function showStatus(control) {
  const [{ reason, agents, running }, autostart] = await control.withCommand(() =>
    Promise.all([control.status(), control.autostart()]));
  const pauses = { manual: 'ручная остановка', conflict: 'конфликт получателей Telegram (409)' };
  if (reason) console.log(`Приём Telegram: пауза (${pauses[reason]})${running ? ', получатель завершает работу' : ''}.`);
  else console.log(`Приём Telegram: ${running ? 'запущен' : 'выключен'}.`);
  for (const agent of ['Codex', 'OpenCode']) {
    console.log(`${agent}: ${running && !reason ? agents?.[agent] ?? 'подключается' : 'приём выключен'}.`);
  }
  console.log(`Автозапуск: ${autostart ? 'включён' : 'выключен'}.`);
  return 0;
}

async function changeAutostart(control, directory, entry, [mode, ...ids]) {
  return control.withCommand(async () => {
    if (mode === 'disable') {
      await control.clearAutostart();
      try {
        await configureAutostart(mode, control, directory, entry);
      } catch {
        console.error('Получателю запрещён автозапуск. Удаление задачи Планировщика или пользовательской службы systemd не подтверждено.');
        return 1;
      }
    } else {
      const previous = await control.autostart();
      const settings = startupSettings(ids);
      const stored = previous ? JSON.parse(previous) : undefined;
      if (stored && isDeepStrictEqual(settings, { ids: stored.ids, environment: stored.environment })) {
        console.log('Автозапуск уже включён с этими настройками.');
        return 0;
      }
      await control.saveAutostart(JSON.stringify({ generation: randomUUID(), ...settings }));
      try {
        await configureAutostart(mode, control, directory, entry);
      } catch {
        if (previous) await control.saveAutostart(previous);
        else {
          await control.clearAutostart();
          await configureAutostart('disable', control, directory, entry).catch(() => {});
        }
        console.error('Автозапуск не включён. Проверьте Планировщик Windows или пользовательскую службу systemd.');
        return 1;
      }
    }
    console.log(`Автозапуск ${mode === 'enable' ? 'включён' : 'выключен'}.`);
    return 0;
  });
}

async function automaticReceiver(directory, control, stop, receive) {
  if (!await control.autostart()) return 0;
  if (process.platform === 'win32') return start(directory, control, undefined, stop, receive);
  if (process.platform !== 'linux') return 1;

  let receiver;
  let attempted;
  try {
    // A lingering systemd manager outlives login. Keep watching for subsequent logins,
    // including while a durable pause prevents polling.
    while (!stop.signal.aborted) {
      const settings = await control.autostart();
      if (!settings) break;
      if (!await ownerLoggedIn(stop.signal)) {
        attempted = undefined;
        receiver?.stop.abort();
      } else if (!stop.signal.aborted && attempted !== settings && !receiver) {
        attempted = settings;
        const localStop = new AbortController();
        const done = start(directory, control, undefined, localStop, receive)
          .catch(() => console.error('Не удалось запустить приём в пользовательской службе.'))
          .finally(() => { receiver = undefined; });
        receiver = { stop: localStop, done };
      }
      await delay(1_000, undefined, { signal: stop.signal }).catch((error) => {
        if (!stop.signal.aborted) throw error;
      });
    }
  } finally {
    receiver?.stop.abort();
    await receiver?.done;
  }
  return 0;
}

export async function receiverCli(args, entry, receive) {
  const [command, ...ids] = args;
  const validCommand = command === 'start' && validIds(ids)
    || ['stop', 'status'].includes(command) && !ids.length
    || command === 'autostart' && (ids[0] === 'enable' && validIds(ids.slice(1)) || ids[0] === 'disable' && ids.length === 1)
    || command === 'auto-run' && ids.length <= 1;
  if (!validCommand) {
    console.error('Команды: node src/receiver.mjs start <сессия> [...] | stop | status | autostart enable <сессия> [...] | autostart disable');
    return 1;
  }

  let directory;
  let control;
  try {
    directory = await profileDirectory(command === 'auto-run' ? ids[0] : undefined);
    control = await openReceiverControl(directory);
  } catch {
    console.error('Приём выключен. Проверьте файлы и права доступа профиля ~/.telegram вне Git.');
    return 1;
  }
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    if (command === 'stop') return await stopReceiver(control);
    if (command === 'status') return await showStatus(control);
    if (command === 'autostart') return await changeAutostart(control, directory, entry, ids);
    if (command === 'auto-run') return await automaticReceiver(directory, control, stop, receive);
    return await start(directory, control, ids, stop, receive);
  } catch {
    console.error('Не удалось выполнить команду. Проверьте права доступа к состоянию управления приёмом в ~/.telegram.');
    return 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
