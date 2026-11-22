import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const files = ['.bot_token', '.chat_id', '.owner_user_id', '.bot_id'];
const execFileAsync = promisify(execFile);

const verifyWindowsAcl = String.raw`
$ErrorActionPreference = 'Stop'
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($owner, 'S-1-5-18', 'S-1-5-32-544')
$directory = $env:TELEGRAM_AGENT_PROFILE_PATH
$paths = @($directory) + @($env:TELEGRAM_AGENT_PROFILE_FILES.Split(',') | ForEach-Object {
    Join-Path $directory $_
})
foreach ($path in $paths) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 1 }
    $acl = Get-Acl -LiteralPath $path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { exit 1 }
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $descriptor.DiscretionaryAcl) { exit 1 }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { exit 1 }
    }
}
`;

async function requireOutsideGit(directory) {
  let ancestor = directory;
  while (true) {
    const marker = await lstat(join(ancestor, '.git')).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (marker) throw new Error('Профиль Telegram должен находиться вне рабочей копии Git.');
    const parent = dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
}

function validPosixAccess(stat, mode) {
  return stat.uid === process.getuid() && (stat.mode & 0o777) === mode;
}

export async function readProfile() {
  const directory = join(await realpath(homedir()), '.telegram');
  const windows = process.platform === 'win32';
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (!windows && !validPosixAccess(stat, 0o700))) {
    throw new Error('Каталог профиля Telegram должен принадлежать владельцу и иметь ограниченный доступ.');
  }
  await requireOutsideGit(directory);
  for (const name of files) {
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.nlink !== 1 || (!windows && !validPosixAccess(info, 0o600))) {
      throw new Error('Файлы профиля Telegram должны принадлежать владельцу и иметь ограниченный доступ.');
    }
  }
  if (windows) {
    await execFileAsync(
      join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(verifyWindowsAcl, 'utf16le').toString('base64')],
      {
        env: {
          ...process.env,
          TELEGRAM_AGENT_PROFILE_PATH: directory,
          TELEGRAM_AGENT_PROFILE_FILES: files.join(','),
        },
        timeout: 10_000,
        windowsHide: true,
      },
    );
  }
  const values = await Promise.all(files.map(async (name) => (await readFile(join(directory, name), 'utf8')).trim()));
  const [token, chatId, ownerId, botId] = values;
  if (!/^[1-9]\d*:[\w-]+$/.test(token) || ![chatId, ownerId, botId].every(isTelegramId)) {
    throw new Error('Некорректные данные профиля Telegram.');
  }
  return { token, chatId: Number(chatId), ownerId: Number(ownerId), botId: Number(botId) };
}

function isTelegramId(value) {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}
