import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const inspectWindows = String.raw`
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $env:TELEGRAM_AGENT_CODEX_PID
$socket = Get-Item -Force -LiteralPath $env:TELEGRAM_AGENT_CODEX_SOCKET
if (-not ($socket.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 1 }
$fileInfo = & (Join-Path $env:SystemRoot 'System32/fsutil.exe') file queryfileid $socket.FullName
if ($LASTEXITCODE -ne 0 -or $fileInfo -notmatch '0x([0-9a-fA-F]{16,32})\b') { exit 1 }
$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
$socket.CreationTimeUtc.ToFileTimeUtc().ToString()
$Matches[1]
`;

async function readRecord(path) {
  const file = await lstat(path);
  if (!file.isFile() || file.size > 8192) return;
  if (process.platform !== 'win32' && file.uid !== process.getuid()) return;
  const data = JSON.parse(await readFile(path, 'utf8'));
  const { pid, processStartTime } = data;
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    if (typeof processStartTime === 'string' && /^[1-9]\d*$/.test(processStartTime)) {
      return { pid, start: processStartTime, bootId: undefined };
    }
  } else {
    const identity = data.processIdentity ?? data.linuxProcessIdentity;
    if (Number.isSafeInteger(identity?.startTicks) && identity.startTicks > 0
      && typeof identity?.bootId === 'string' && /^[\da-f-]{36}$/i.test(identity.bootId)) {
      return { pid, start: String(identity.startTicks), bootId: identity.bootId };
    }
  }
}

async function windowsIdentity(pid, path, start) {
  const { stdout } = await exec(
    join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(inspectWindows, 'utf16le').toString('base64')],
    {
      windowsHide: true, timeout: 4000,
      env: { ...process.env, TELEGRAM_AGENT_CODEX_PID: String(pid), TELEGRAM_AGENT_CODEX_SOCKET: path },
    },
  );
  const [processCreated, socketCreated, fileId] = stdout.trim().split(/\r?\n/);
  if (processCreated === start && /^[1-9]\d*$/.test(socketCreated)
    && /^[0-9a-f]{16,32}$/i.test(fileId) && BigInt(socketCreated) >= BigInt(processCreated)) {
    return [socketCreated, fileId.toLowerCase()].join(':');
  }
}

async function linuxIdentity(pid, path, start, bootId) {
  const target = await realpath(path);
  const socket = await lstat(target, { bigint: true });
  if (!socket.isSocket() || socket.uid !== BigInt(process.getuid())) return;
  const [stat, boot, sockets] = await Promise.all([
    readFile('/proc/' + pid + '/stat', 'utf8'),
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    readFile('/proc/' + pid + '/net/unix', 'utf8'),
  ]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  // proc stat starts its trailing columns at field 3. Linux records start time in field 22.
  if (fields[0] === 'Z' || fields[19] !== start || boot.trim() !== bootId || socket.ino <= 0n || socket.ctimeNs <= 0n) return;
  // The published Unix path can be a symlink or a forwarder. Match the actual listener to the managed process.
  const listeners = sockets.split('\n').flatMap((line) => {
    const match = /^\S+\s+\S+\s+\S+\s+00010000\s+0001\s+01\s+(\d+)\s+(.+)$/.exec(line.trim());
    return match?.[2] === target ? [match[1]] : [];
  });
  if (listeners.length !== 1) return;
  const fdRoot = '/proc/' + pid + '/fd';
  const fds = await readdir(fdRoot);
  const links = await Promise.all(fds.map((fd) => readlink(join(fdRoot, fd)).catch(() => undefined)));
  if (links.includes('socket:[' + listeners[0] + ']')) return [bootId, socket.dev, socket.ino, socket.ctimeNs, listeners[0]].join(':');
}

// The managed daemon writes a new control socket on each launch. PID plus system
// start time alone cannot identify the listener selected by the unqualified proxy.
export async function codexInstance(home) {
  if (!['linux', 'win32'].includes(process.platform)) return;
  try {
    const root = await realpath(home);
    const path = join(root, 'app-server-control', 'app-server-control.sock');
    const candidates = await Promise.all(['daemon.pid', 'app-server.pid'].map((name) =>
      readRecord(join(root, 'app-server-daemon', name)).catch(() => undefined)));
    const identify = process.platform === 'win32' ? windowsIdentity : linuxIdentity;
    const fingerprints = new Set();
    for (const record of candidates) {
      if (!record) continue;
      const { pid, start, bootId } = record;
      const socket = await identify(pid, path, start, bootId).catch(() => undefined);
      if (socket) fingerprints.add(createHash('sha256').update(JSON.stringify([root, pid, start, socket])).digest('hex'));
    }
    if (fingerprints.size === 1) return [...fingerprints][0];
  } catch {
    // An unmanaged or unverified listener is usable live, without durable continuity.
  }
}
