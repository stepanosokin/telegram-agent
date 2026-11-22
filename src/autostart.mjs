import { execFile } from 'node:child_process';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const options = { timeout: 10_000, windowsHide: true };

const configureTask = String.raw`
$ErrorActionPreference = 'Stop'
$name = $env:TELEGRAM_AGENT_TASK_NAME
if ($env:TELEGRAM_AGENT_TASK_MODE -eq 'disable') {
    if (Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -TaskPath '\' -Confirm:$false
    }
    exit
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$action = New-ScheduledTaskAction -Execute $env:TELEGRAM_AGENT_NODE -Argument $env:TELEGRAM_AGENT_ARGUMENTS -WorkingDirectory $env:TELEGRAM_AGENT_WORKING_DIR
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`;

function systemdArgument(value) {
  if (/[\n\r\0]/.test(value)) throw new Error('Неподдерживаемый путь для пользовательской службы systemd.');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
}

async function configureUserService(mode, name, directory, entry, profile) {
  const unit = join(directory, `${name}.service`);
  if (mode === 'disable') {
    const stat = await lstat(unit).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (!stat) return;
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Недопустимый файл пользовательской службы.');
    await execute('systemctl', ['--user', 'disable', '--now', `${name}.service`], options);
    await unlink(unit);
    return;
  }
  const command = [process.execPath, entry, 'auto-run', profile].map(systemdArgument).join(' ');
  const contents = `[Unit]
Description=Telegram Agent receiver for the owner login

[Service]
ExecStart=${command}
Restart=no

[Install]
WantedBy=default.target
`;
  try {
    await writeFile(unit, contents, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST' || !(await lstat(unit)).isFile() || await readFile(unit, 'utf8') !== contents) throw error;
  }
  await execute('systemctl', ['--user', 'enable', '--now', unit], options);
}

export async function configureAutostart(mode, control, profile, entry) {
  const name = `telegram-agent-${control.fileId}`;
  if (process.platform === 'win32') {
    await execute(
      join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(configureTask, 'utf16le').toString('base64')],
      {
        ...options,
        env: {
          ...process.env,
          TELEGRAM_AGENT_TASK_NAME: name,
          TELEGRAM_AGENT_TASK_MODE: mode,
          TELEGRAM_AGENT_NODE: process.execPath,
          TELEGRAM_AGENT_ARGUMENTS: `"${entry}" auto-run "${profile}"`,
          TELEGRAM_AGENT_WORKING_DIR: dirname(entry),
        },
      },
    );
    return;
  }
  if (process.platform !== 'linux') throw new Error('Автозапуск поддерживается на Windows и Linux.');
  await configureUserService(mode, name, control.directory, entry, profile);
}

export async function ownerLoggedIn(signal) {
  const uid = String(process.getuid());
  try {
    const loginOptions = { ...options, signal };
    const { stdout } = await execute('loginctl', ['show-user', uid, '--property=Sessions', '--value'], loginOptions);
    const ids = stdout.trim().split(/\s+/).filter((value) => /^[\w-]+$/.test(value));
    for (const id of ids) {
      if (signal.aborted) return false;
      const session = await execute('loginctl', ['show-session', id, '--property=User,Class,State'], loginOptions).catch(() => undefined);
      if (!session) continue;
      const properties = Object.fromEntries(session.stdout.trim().split(/\r?\n/).map((line) => line.split('=')));
      if (properties.User === uid && ['active', 'online'].includes(properties.State)
        && ['user', 'user-early', 'user-light', 'user-early-light'].includes(properties.Class)) return true;
    }
  } catch {
    // A lingering manager alone can never authorize incoming polling.
  }
  return false;
}

const environmentKeys = ['PATH', 'CODEX_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];

export function startupSettings(ids) {
  return { ids, environment: Object.fromEntries(environmentKeys.flatMap((key) => {
    const value = process.env[key];
    return value ? [[key, value]] : [];
  })) };
}

export function restoreStartupEnvironment(settings, profile) {
  const key = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const savedHome = dirname(profile);
  if (savedHome !== homedir()) process.env[key] = savedHome;
  for (const name of environmentKeys) {
    if (typeof settings.environment?.[name] === 'string') process.env[name] = settings.environment[name];
  }
}
