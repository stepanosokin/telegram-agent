import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const holdWindowsLock = String.raw`
$ErrorActionPreference = 'Stop'
try {
    $file = [IO.FileStream]::new($env:TELEGRAM_AGENT_LOCK_PATH, 'OpenOrCreate', 'ReadWrite', 'Read')
} catch {
    $cause = $_.Exception.GetBaseException()
    if (($cause.HResult -band 0xffff) -in @(32, 33)) { exit 75 }
    throw
}
try {
    [Console]::Out.WriteLine('locked')
    $null = [Console]::In.Read()
} finally {
    $file.Dispose()
}
`;

async function lockWindows(path, onLoss) {
  const child = spawn(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(holdWindowsLock, 'utf16le').toString('base64'),
  ], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    env: { ...process.env, TELEGRAM_AGENT_LOCK_PATH: path },
  });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  const closed = once(child, 'close');
  const deadline = setTimeout(() => child.kill(), 10_000);
  try {
    const [line] = await Promise.race([once(lines, 'line'), closed]);
    if (line === 75) return undefined;
    if (line !== 'locked') throw new Error('Не удалось получить файловую блокировку Windows.');
    let releasing = false;
    void closed.then(() => { if (!releasing) onLoss?.(); });
    return async () => {
      releasing = true;
      child.stdin.end();
      await closed;
    };
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(deadline);
    lines.close();
  }
}

async function lockLinux(path) {
  const file = await open(path, constants.O_NOFOLLOW | constants.O_RDWR | constants.O_CREAT, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
      throw new Error('Некорректный файл блокировки получателя.');
    }
    // flock locks the open file description shared with the parent via fd 3.
    // The description lives in Node until it closes the file or exits.
    const child = spawn('flock', ['--nonblock', '--conflict-exit-code', '75', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', file.fd],
    });
    const [code] = await once(child, 'close');
    if (code === 0) return () => file.close();
    if (code !== 75) throw new Error('Не удалось получить файловую блокировку Linux.');
  } catch (error) {
    await file.close();
    throw error;
  }
  await file.close();
  return undefined;
}

export function acquireLocalLock(path, onLoss) {
  if (process.platform === 'win32') return lockWindows(path, onLoss);
  if (process.platform === 'linux') return lockLinux(path);
  throw new Error('Получатель поддерживается на Windows и Linux.');
}
