import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { chmod, link, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const primaryThread = '01900000-0000-7000-8000-000000000001';
const otherThread = '01900000-0000-7000-8000-000000000002';
const receiver = new URL('../src/receiver.mjs', import.meta.url);
const setup = new URL('./setup-api.mjs', import.meta.url);
const baseMessage = {
  message_id: 30,
  from: { id: 300, is_bot: false },
  chat: { id: 200, type: 'private' },
  text: 'Продолжай с публичными данными',
  reply_to_message: { message_id: 1, from: { id: 100, is_bot: true } },
};
function reply(overrides = {}, id = 10) {
  return { update_id: id, message: { ...baseMessage, ...overrides } };
}

function newText(text, messageId = 30, updateId = 10) {
  return reply({ text, message_id: messageId, reply_to_message: undefined }, updateId);
}

async function run(scenario, threads = [primaryThread]) {
  const home = await mkdtemp(join(tmpdir(), 'telegram-agent-test-'));
  const profile = join(home, '.telegram');
  try {
    if (process.platform === 'win32') {
      const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:TELEGRAM_AGENT_TEST_HOME
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $path /grant:r ('*' + $sid + ':(OI)(CI)F') /inheritance:r | Out-Null
exit $LASTEXITCODE
`;
      await promisify(execFile)('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
      ], { env: { ...process.env, TELEGRAM_AGENT_TEST_HOME: home }, windowsHide: true });
    }
    await mkdir(profile, { mode: 0o700 });
    const files = {
      '.bot_token': '100:fixture-not-a-secret',
      '.bot_id': '100',
      '.chat_id': '200',
      '.owner_user_id': '300',
    };
    for (const [name, value] of Object.entries(files)) {
      await writeFile(join(profile, name), value, { mode: 0o600 });
    }
    if (scenario.profile === 'missing owner') await unlink(join(profile, '.owner_user_id'));
    if (scenario.profile === 'worktree') await writeFile(join(home, '.git'), 'gitdir: fixture\n');
    if (scenario.profile === 'linked token') await link(join(profile, '.bot_token'), join(home, 'token-copy'));
    if (scenario.profile === 'public token') {
      const file = join(profile, '.bot_token');
      if (process.platform === 'win32') {
        await promisify(execFile)('icacls.exe', [file, '/grant', '*S-1-1-0:R']);
      } else {
        await chmod(file, 0o644);
      }
    }
    const child = fork(receiver, ['start', ...threads], {
      execArgv: ['--import', setup.href],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TELEGRAM_AGENT_SCENARIO: JSON.stringify(scenario),
      },
      silent: true,
    });
    const calls = [];
    let stderr = '';
    child.on('message', (call) => calls.push(call));
    child.stderr.setEncoding('utf8').on('data', (text) => stderr += text);
    const deadline = setTimeout(() => child.kill(), 15_000);
    try {
      const [code] = await once(child, 'close');
      return { calls, code, stderr };
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function callsFor(result, channel, method) {
  return result.calls.filter((call) => call.channel === channel && call.method === method);
}

test('публикует сообщение Codex и передаёт ответ в исходную свободную сессию', async () => {
  const result = await run({ updates: [reply()] });
  assert.match(result.stderr, /конфликт получателей/i);
  const [published] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(published.params.text, /Codex.*Первый диалог\s+Ответ 1/s);
  assert.equal(published.params.chat_id, 200);
  const [queued] = callsFor(result, 'codex', 'thread/queue/add');
  assert.equal(queued.params.threadId, primaryThread);
  assert.equal(queued.params.input[0].text, baseMessage.text);
  const [started] = callsFor(result, 'codex', 'thread/queue/start');
  assert.deepEqual(started.params, { threadId: primaryThread, queuedSubmissionId: 'in-queue' });
});

test('сохраняет адресата ответа при нескольких подключённых сессиях', async () => {
  const result = await run({
    sessions: {
      [primaryThread]: { name: 'Один', status: { type: 'idle' } },
      [otherThread]: { name: 'Два', status: { type: 'idle' } },
    },
    updates: [reply()],
  }, [primaryThread, otherThread]);
  const texts = callsFor(result, 'telegram', 'sendMessage').map(({ params }) => params.text);
  assert.deepEqual(texts, [
    'Codex · …00000001 · Один\n\nОтвет 1', 'Codex · …00000002 · Два\n\nОтвет 2', 'Codex принял ваш ответ.',
  ]);
  assert.deepEqual(
    callsFor(result, 'codex', 'thread/queue/add').map(({ params }) => params.threadId),
    [primaryThread],
  );
});

test('показывает различимый выбор сессии и не отправляет текст до нажатия', async () => {
  const result = await run({
    sessions: {
      [primaryThread]: { name: 'Общее название', status: { type: 'idle' } },
      [otherThread]: { name: 'Общее название', status: { type: 'idle' } },
    },
    updates: [newText('Сообщение с выбором адресата')],
  }, [primaryThread, otherThread]);
  const prompt = callsFor(result, 'telegram', 'sendMessage')
    .find(({ params }) => params.reply_parameters?.message_id === 30);
  assert.match(prompt?.params.text ?? '', /выберите сессию/i);
  const labels = prompt.params.reply_markup.inline_keyboard.flat().map(({ text }) => text);
  assert.equal(labels.length, 2);
  assert.ok(labels.every((label) => /Codex.*Общее название/.test(label)));
  assert.equal(new Set(labels).size, 2);
  assert.equal(callsFor(result, 'codex', 'thread/queue/add').length, 0);
  assert.equal(callsFor(result, 'codex', 'turn/steer').length, 0);
});

test('направляет отдельные тексты в разные сессии при выборе в обратном порядке', async () => {
  const result = await run({
    sessions: {
      [primaryThread]: { name: 'Один', status: { type: 'idle' } },
      [otherThread]: { name: 'Два', status: { type: 'idle' } },
    },
    updates: [newText('Первый текст'), newText('Второй текст', 31, 11), newText('Третий текст', 32, 12)],
    callbacks: [
      { prompt: 1, choice: 1 },
      { prompt: 0, choice: 0 },
      { prompt: 1, choice: 0, messageOverrides: { reply_to_message: null } },
    ],
  }, [primaryThread, otherThread]);
  const queued = callsFor(result, 'codex', 'thread/queue/add');
  assert.deepEqual(queued.map(({ params }) => [params.threadId, params.input[0].text]), [
    [otherThread, 'Второй текст'], [primaryThread, 'Первый текст'],
  ]);
  const initialPoll = callsFor(result, 'telegram', 'getUpdates')[0];
  assert.ok(initialPoll.params.allowed_updates.includes('callback_query'));
  const statuses = callsFor(result, 'telegram', 'editMessageText').map(({ params }) => params);
  assert.deepEqual(statuses.map(({ message_id, reply_markup }) => [message_id, reply_markup]), [
    [4, { inline_keyboard: [] }], [3, { inline_keyboard: [] }],
  ]);
  assert.match(callsFor(result, 'telegram', 'answerCallbackQuery').at(-1)?.params.text ?? '', /уже принят/i);
});

test('сохраняет адресат старого ответа и предлагает выбор для неподтверждённой привязки', async () => {
  const result = await run({
    sessions: {
      [primaryThread]: { name: 'Один', status: { type: 'idle' } },
      [otherThread]: { name: 'Два', status: { type: 'idle' } },
    },
    updates: [
      newText('Новый текст'),
      reply({ message_id: 31, text: 'Ответ другому диалогу' }, 11),
      reply({ message_id: 32, text: 'Ответ по старой привязке', reply_to_message: {
        message_id: 99, from: { id: 100, is_bot: true },
      } }, 12),
    ],
    callbacks: [{ prompt: 0, choice: 1 }, { prompt: 1, choice: 0 }],
  }, [primaryThread, otherThread]);
  const fallback = callsFor(result, 'telegram', 'sendMessage')
    .find(({ params }) => params.reply_parameters?.message_id === 32);
  assert.match(fallback?.params.text ?? '', /проверьте исходную сессию.*выберите сессию/is);
  assert.deepEqual(callsFor(result, 'codex', 'thread/queue/add').map(({ params }) => [params.threadId, params.input[0].text]), [
    [primaryThread, 'Ответ другому диалогу'], [otherThread, 'Новый текст'], [primaryThread, 'Ответ по старой привязке'],
  ]);
});

test('отклоняет кнопку от неверного владельца, чата, текста или сообщения бота', async () => {
  const result = await run({
    updates: [newText('Первый текст'), newText('Второй текст', 31, 11)],
    callbacks: [
      { prompt: 0, choice: 0, from: { id: 301, is_bot: false } },
      { prompt: 0, choice: 0, messageOverrides: { chat: { id: 201, type: 'private' } } },
      { prompt: 0, choice: 0, messageOverrides: { chat: { id: 200, type: 'group' } } },
      { prompt: 0, choice: 0, messageOverrides: { from: { id: 101, is_bot: true } } },
      { prompt: 0, choice: 0, messageOverrides: { date: 0 } },
      { prompt: 0, choice: 0, messageOverrides: { reply_to_message: { ...baseMessage, text: 'Изменённый текст' } } },
      { prompt: 0, choice: 0, tokenFrom: 1 },
      { prompt: 0, choice: 0 },
    ],
  });
  const acknowledgements = callsFor(result, 'telegram', 'answerCallbackQuery');
  assert.deepEqual(acknowledgements.map(({ params }) => params.callback_query_id), [
    'callback-5', 'callback-6', 'callback-7',
  ]);
  assert.match(acknowledgements[0].params.text, /исходный текст недоступен или изменился/i);
  assert.match(acknowledgements[1].params.text, /выбор недоступен/i);
  assert.deepEqual(callsFor(result, 'codex', 'thread/queue/add').map(({ params }) => params.input[0].text), ['Первый текст']);
});

test('проверяет доступность выбранной сессии и позволяет выбрать другую после отказа', async () => {
  const result = await run({
    sessions: {
      [primaryThread]: { name: 'Один', status: { type: 'idle' } },
      [otherThread]: { name: 'Два', status: { type: 'idle' } },
    },
    loaded: [[primaryThread, otherThread], [primaryThread, otherThread], [primaryThread]],
    updates: [newText('Первый текст')],
    callbacks: [{ prompt: 0, choice: 1 }, { prompt: 0, choice: 0 }],
  }, [primaryThread, otherThread]);
  assert.match(callsFor(result, 'telegram', 'sendMessage').at(-1)?.params.text ?? '', /ответ не доставлен/i);
  assert.deepEqual(callsFor(result, 'codex', 'thread/queue/add').map(({ params }) => params.threadId), [primaryThread]);
});

test('сохраняет различимый признак одноимённой сессии, если список сократился', async () => {
  const result = await run({
    sessions: {
      [primaryThread]: { name: 'Общее название', status: { type: 'idle' } },
      [otherThread]: { name: 'Общее название', status: { type: 'idle' } },
    },
    loaded: [[primaryThread, otherThread], [primaryThread, otherThread], [otherThread]],
    updates: [newText('Первый текст'), reply({ message_id: 31 }, 11)],
  }, [primaryThread, otherThread]);
  const keyboards = callsFor(result, 'telegram', 'sendMessage')
    .filter(({ params }) => params.reply_markup).map(({ params }) => params.reply_markup.inline_keyboard);
  assert.equal(keyboards[0].length, 2);
  assert.equal(keyboards[1].length, 1);
  assert.equal(keyboards[1][0][0].text, keyboards[0][1][0].text);
});

test('показывает только подтверждённую живым событием сессию, когда другая могла открыться из истории', async () => {
  const result = await run({
    sessions: {
      [primaryThread]: { name: 'Сохранённый диалог', status: { type: 'idle' } },
      [otherThread]: { name: 'Подключённый диалог', status: { type: 'idle' } },
    },
    withoutItem: [primaryThread],
    updates: [newText('Первый текст')],
    callbacks: [{ prompt: 0, choice: 0 }],
  }, [primaryThread, otherThread]);
  const prompt = callsFor(result, 'telegram', 'sendMessage').find(({ params }) => params.reply_markup);
  assert.equal(prompt.params.reply_markup.inline_keyboard.length, 1);
  assert.match(prompt.params.reply_markup.inline_keyboard[0][0].text, /Подключённый диалог/);
  assert.deepEqual(callsFor(result, 'codex', 'thread/queue/add').map(({ params }) => params.threadId), [otherThread]);
});

test('сверяет активный ход, открытый на общем сервере', async () => {
  const result = await run({
    sessions: {
      [primaryThread]: {
        name: 'Активная сессия', status: { type: 'active' }, turns: [{ id: 'live-42', status: 'inProgress' }],
      },
    },
    updates: [reply()],
  });
  assert.equal(callsFor(result, 'codex', 'thread/turns/list').length, 1);
  const [steer] = callsFor(result, 'codex', 'turn/steer');
  assert.equal(steer.params.expectedTurnId, 'live-42');
  assert.equal(steer.params.threadId, primaryThread);
  assert.equal(callsFor(result, 'codex', 'thread/queue/add').length, 0);
});

test('отклоняет ответ после смены активного хода без запасной отправки', async () => {
  const result = await run({
    sessions: {
      [primaryThread]: { status: { type: 'active' }, turns: [{ id: 'previous', status: 'inProgress' }] },
    },
    updates: [reply()],
    changedActiveTurn: true,
  });
  assert.equal(callsFor(result, 'codex', 'turn/steer').length, 1);
  assert.equal(callsFor(result, 'codex', 'thread/queue/add').length, 0);
  assert.match(callsFor(result, 'telegram', 'sendMessage').at(-1).params.text, /Ответ не доставлен/);
});

test('не отправляет текст без проверяемого активного хода', async () => {
  const result = await run({
    sessions: {
      [primaryThread]: { status: { type: 'active' }, turns: [{ id: 'old', status: 'completed' }] },
    },
    updates: [reply()],
  });
  assert.equal(callsFor(result, 'codex', 'turn/steer').length, 0);
  assert.equal(callsFor(result, 'codex', 'thread/queue/add').length, 0);
  assert.match(callsFor(result, 'telegram', 'sendMessage').at(-1).params.text, /Ответ не доставлен/);
});

test('при обрыве после передачи запроса сообщает о неподтверждённом результате', async () => {
  const result = await run({
    sessions: {
      [primaryThread]: { status: { type: 'active' }, turns: [{ id: 'active', status: 'inProgress' }] },
    },
    updates: [reply()],
    steerDisconnect: true,
  });
  assert.equal(callsFor(result, 'codex', 'turn/steer').length, 1);
  assert.equal(callsFor(result, 'codex', 'thread/queue/add').length, 0);
  assert.match(callsFor(result, 'telegram', 'sendMessage').at(-1).params.text, /проверьте историю/i);
});

test('отменяет поставленный в очередь текст при новом конкурирующем ходе', async () => {
  const result = await run({ updates: [reply()], concurrentTurn: true });
  assert.deepEqual(callsFor(result, 'codex', 'thread/queue/delete')[0].params, {
    threadId: primaryThread, queuedSubmissionId: 'in-queue',
  });
  assert.equal(callsFor(result, 'codex', 'turn/steer').length, 0);
  assert.match(callsFor(result, 'telegram', 'sendMessage').at(-1).params.text, /Ответ не доставлен/);
});

test('подтверждает доставку, если сервер уже снял текст с очереди и показал его в сессии', async () => {
  const result = await run({ updates: [reply()], autoQueueStart: true });
  assert.equal(callsFor(result, 'codex', 'thread/queue/add').length, 1);
  assert.equal(callsFor(result, 'codex', 'turn/steer').length, 0);
  assert.equal(callsFor(result, 'telegram', 'sendMessage').at(-1).params.text, 'Codex принял ваш ответ.');
});

test('не пытается отправить текст, если сервер перестал подтверждать сессию', async () => {
  const result = await run({ loaded: [[primaryThread], []], updates: [reply()] });
  assert.equal(callsFor(result, 'codex', 'turn/steer').length, 0);
  assert.equal(callsFor(result, 'codex', 'thread/queue/add').length, 0);
  assert.match(callsFor(result, 'telegram', 'sendMessage').at(-1).params.text, /Ответ не доставлен/);
});

test('сохранённый диалог без подтверждённой сессии оставляет приём выключенным', async () => {
  const result = await run({ loaded: [[]], updates: [reply()] });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /не подтвердил ни одной указанной сессии/);
  assert.equal(callsFor(result, 'codex', 'thread/resume').length, 0);
  assert.equal(callsFor(result, 'telegram', 'getUpdates').length, 0);
});

test('подписка без нового сообщения агента не даёт маршрута для ответа', async () => {
  const result = await run({ noNewItem: true, updates: [reply()] });
  assert.equal(callsFor(result, 'codex', 'thread/resume').length, 1);
  assert.equal(callsFor(result, 'codex', 'thread/read').length, 1);
  assert.equal(callsFor(result, 'codex', 'thread/queue/add').length, 0);
  assert.match(callsFor(result, 'telegram', 'sendMessage').at(-1).params.text, /Ответ не доставлен/);
});

test('сбой отправки статуса не повторяет доставку и не останавливает опрос', async () => {
  const result = await run({ failStatus: true, updates: [reply()] });
  assert.equal(callsFor(result, 'codex', 'thread/queue/start').length, 1);
  assert.equal(callsFor(result, 'telegram', 'getUpdates').at(-1).params.offset, 11);
  assert.match(result.stderr, /Telegram не подтвердил отправку статуса/);
  assert.match(result.stderr, /конфликт получателей/i);
});

test('сообщения от неверного автора или чата и сообщения без данных не доходят до Codex', async () => {
  const updates = [
    reply({ from: { id: 301, is_bot: false } }, 11),
    reply({ from: { id: 300, is_bot: true } }, 12),
    reply({ from: { id: 300 } }, 13),
    reply({ from: null }, 14),
    reply({ chat: { id: 201, type: 'private' } }, 15),
    reply({ chat: { id: 200, type: 'group' } }, 16),
    reply({ chat: { id: 200 } }, 17),
    reply({ message_id: null }, 18),
    reply({ text: null }, 19),
    { update_id: 20, edited_message: baseMessage },
    { update_id: 21, callback_query: { message: baseMessage } },
  ];
  const result = await run({ updates });
  assert.equal(callsFor(result, 'codex', 'thread/read').length, 1);
  assert.equal(callsFor(result, 'codex', 'turn/steer').length, 0);
  assert.equal(callsFor(result, 'codex', 'thread/queue/add').length, 0);
  assert.equal(callsFor(result, 'telegram', 'sendMessage').length, 1);
});

test('отклоняет непривязанный ответ и не повторяет одно обновление', async () => {
  const result = await run({
    updates: [
      reply({ reply_to_message: { message_id: 1, from: { id: 101, is_bot: true } } }, 11),
      reply({ reply_to_message: { message_id: 7000, from: { id: 100, is_bot: true } } }, 12),
      reply({}, 13),
      reply({}, 13),
    ],
  });
  assert.equal(callsFor(result, 'codex', 'thread/queue/add').length, 1);
  assert.equal(callsFor(result, 'telegram', 'getUpdates').at(-1).params.offset, 14);
  assert.equal(callsFor(result, 'telegram', 'sendMessage').length, 4);
});

test('не начинает приём, если Telegram не подтверждает закреплённого бота или личный чат', async (t) => {
  for (const [name, telegram] of Object.entries({
    'другой бот': { bot: { id: 101, is_bot: true } },
    'неполный ответ о боте': { bot: { id: 100 } },
    'другой чат': { chat: { id: 201, type: 'private' } },
    'чат группы': { chat: { id: 200, type: 'group' } },
  })) {
    await t.test(name, async () => {
      const result = await run({ telegram });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Telegram не подтвердил ID/);
      assert.equal(callsFor(result, 'telegram', 'getUpdates').length, 0);
      assert.equal(result.calls.some(({ channel }) => channel === 'codex'), false);
    });
  }
});

test('блокирует запуск с неполным или незащищённым профилем до сетевого обращения', async (t) => {
  for (const [name, profile] of Object.entries({
    'нет ID владельца': 'missing owner',
    'рабочая копия Git': 'worktree',
    'жёсткая ссылка на токен': 'linked token',
    'токен доступен другому пользователю': 'public token',
  })) {
    await t.test(name, async () => {
      const result = await run({ profile });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /права доступа профиля/);
      assert.deepEqual(result.calls, []);
    });
  }
});
