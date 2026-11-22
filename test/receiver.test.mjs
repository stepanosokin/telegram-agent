import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const primaryThread = '01900000-0000-7000-8000-000000000001';
const otherThread = '01900000-0000-7000-8000-000000000002';
const openCodeSession = 'ses_01900000000070008000000000000001';
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

async function run(scenario, threads = [primaryThread], restart) {
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
    const openCodeState = join(home, 'state');
    async function registerOpenCode(options) {
      if (!options) return;
      const stateDir = join(openCodeState, 'opencode');
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await writeFile(join(stateDir, 'service.json'), JSON.stringify({
        id: options.registrationId ?? 'fixture-instance', version: '2.3.2', url: options.registrationUrl ?? 'http://127.0.0.1:32123', pid: 1234,
        password: 'fixture-not-a-secret',
      }), { mode: 0o600 });
    }
    await registerOpenCode(scenario.openCode);
    const first = await runReceiver(scenario, threads, home, openCodeState);
    if (scenario.inspectRecovery) {
      const directory = join(profile, 'receiver-text-v1-100-200-300');
      const names = await readdir(directory);
      first.recovery = await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')));
      if (restart) await link(join(directory, 'binding-1'), join(home, 'binding-copy'));
    }
    if (!restart) return first;
    await registerOpenCode(restart.openCode);
    return [first, await runReceiver({ firstMessageId: 50, ...restart }, threads, home, openCodeState)];
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function runReceiver(scenario, threads, home, openCodeState) {
  const child = fork(receiver, ['start', ...threads], {
    execArgv: ['--import', setup.href],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_STATE_HOME: openCodeState,
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
}

function callsFor(result, channel, method) {
  return result.calls.filter((call) => call.channel === channel && call.method === method);
}

const harmlessChoice = {
  method: 'item/tool/requestUserInput',
  id: 1,
  params: {
    threadId: primaryThread, turnId: 'asking-turn', itemId: 'question-item',
    isBlocking: true, autoResolutionMs: null,
    questions: [{
      id: 'color', header: 'Цвет', question: 'Какой цвет выбрать?', isOther: false, isSecret: false,
      options: [
        { label: 'Синий', description: 'Цвет неба' },
        { label: 'Зелёный', description: 'Цвет листвы' },
      ],
    }],
  },
};

const askingSession = {
  [primaryThread]: { name: 'Первый диалог', status: { type: 'active' }, turns: [{ id: 'asking-turn', status: 'inProgress' }] },
};

const codexApproval = {
  method: 'item/commandExecution/requestApproval',
  id: 'approval-1',
  params: {
    threadId: primaryThread, turnId: 'asking-turn', itemId: 'command-1',
    startedAtMs: 1, command: 'echo hello', cwd: '/fixture',
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
  },
};

const openCodeApproval = {
  id: 'per_fixture', sessionID: openCodeSession, action: 'read', resources: ['/fixture/example.txt'],
  save: ['/fixture/*'], source: { type: 'tool', messageID: 'msg_fixture', id: 'tool-fixture' },
};

test('прекращает запуск, если proxy Codex не завершает рукопожатие', async () => {
  const result = await run({ codexHandshakeStalls: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ошибка связи с общим App Server Codex/i);
  assert.deepEqual(callsFor(result, 'telegram', 'getUpdates'), []);
});

test('однократно передаёт разовое разрешение Codex в исходный запрос', async () => {
  const reason = 'Показать тестовое сообщение в терминале';
  const result = await run({
    codexChoice: { ...codexApproval, params: { ...codexApproval.params, reason } },
    sessions: askingSession, noNewItem: true,
    callbacks: [{ prompt: 0, choice: 0 }, { prompt: 0, choice: 1 }],
  });
  const [prompt] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(prompt?.params.text, /Codex.*Первый диалог[\s\S]*echo hello[\s\S]*\/fixture/);
  assert.ok(prompt.params.text.includes(`Причина по данным Codex: ${reason}`));
  assert.deepEqual(prompt.params.reply_markup.inline_keyboard.flat().map(({ text }) => text),
    ['Разрешить один раз', 'Отклонить']);
  assert.deepEqual(callsFor(result, 'codex', 'serverResponse').map(({ params }) => params), [
    { id: 'approval-1', result: { decision: 'accept' } },
  ]);
  const [edit] = callsFor(result, 'telegram', 'editMessageText');
  assert.equal(edit.params.message_id, 1);
  assert.deepEqual(edit.params.reply_markup.inline_keyboard, []);
  assert.match(callsFor(result, 'telegram', 'answerCallbackQuery').at(-1).params.text, /решение.*отправлено/i);
});

test('показывает контекст разрешения OpenCode и направляет решение в исходную сессию', async () => {
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Диалог OpenCode', permission: openCodeApproval },
    callbacks: [{ prompt: 0, choice: 0, data: 'permission:forged',
      messageOverrides: { message_id: 1, chat: baseMessage.chat, date: 1, from: { id: 100, is_bot: true } } }],
  }, [`opencode:${openCodeSession}`]);
  const [prompt] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(prompt?.params.text, /OpenCode.*Диалог OpenCode[\s\S]*read[\s\S]*example\.txt/);
  assert.match(prompt.params.text, /ответ на компьютере/);
  assert.equal(prompt.params.reply_markup, undefined);
  assert.ok(callsFor(result, 'opencode', `GET /api/session/${openCodeSession}/permission/${openCodeApproval.id}`).length);
  const replyPath = `POST /api/session/${openCodeSession}/permission/${openCodeApproval.id}/reply`;
  assert.deepEqual(callsFor(result, 'opencode', replyPath), []);
  assert.match(callsFor(result, 'telegram', 'answerCallbackQuery')[0]?.params.text, /недоступно/);
});

test('текст «разрешить» в ответ на запрос передаётся в диалог Codex как текст', async () => {
  const result = await run({
    codexChoice: codexApproval, sessions: askingSession, noNewItem: true,
    updates: [reply({ text: 'Разрешить' })],
  });
  assert.deepEqual(callsFor(result, 'codex', 'serverResponse'), []);
  assert.deepEqual(callsFor(result, 'codex', 'turn/steer').map(({ params }) => params), [{
    threadId: primaryThread, expectedTurnId: 'asking-turn',
    input: [{ type: 'text', text: 'Разрешить', text_elements: [] }],
  }]);
});

test('кнопка Codex сверяет владельца, личный чат, сообщение и допустимое решение', async () => {
  const declineOnly = { ...codexApproval, params: { ...codexApproval.params, availableDecisions: ['acceptForSession', 'decline'] } };
  const result = await run({
    codexChoice: declineOnly, sessions: askingSession, noNewItem: true,
    callbacks: [
      { prompt: 0, choice: 0, from: { id: 999, is_bot: false } },
      { prompt: 0, choice: 0, messageOverrides: { chat: { id: 200, type: 'group' } } },
      { prompt: 0, choice: 0, messageOverrides: { chat: { id: 201, type: 'private' } } },
      { prompt: 0, choice: 0, messageOverrides: { message_id: 2 } },
      { prompt: 0, choice: 0, data: 'permission:forged' },
      { prompt: 0, choice: 0, messageOverrides: { from: { id: 999, is_bot: true } } },
      { prompt: 0, choice: 0 },
    ],
  });
  const [prompt] = callsFor(result, 'telegram', 'sendMessage');
  assert.deepEqual(prompt.params.reply_markup.inline_keyboard.flat().map(({ text }) => text), ['Отклонить']);
  assert.deepEqual(callsFor(result, 'codex', 'serverResponse').map(({ params }) => params),
    [{ id: declineOnly.id, result: { decision: 'decline' } }]);
  const statuses = callsFor(result, 'telegram', 'answerCallbackQuery').map(({ params }) => params.text);
  assert.equal(statuses.length, 3);
  assert.match(statuses[0], /недоступно/i);
  assert.match(statuses[1], /недоступно/i);
  assert.match(statuses[2], /решение отправлено/i);
});

test('закрытие разрешения Codex при проверке хода блокирует решение', async () => {
  const result = await run({
    codexChoice: codexApproval, sessions: askingSession, noNewItem: true,
    callbacks: [{ prompt: 0, choice: 0 }],
    closeWhileChecking: {
      method: 'serverRequest/resolved', params: { threadId: primaryThread, requestId: codexApproval.id },
    },
  });
  assert.deepEqual(callsFor(result, 'codex', 'serverResponse'), []);
  assert.match(callsFor(result, 'telegram', 'answerCallbackQuery')[0]?.params.text, /запрос уже закрыт/i);
});

test('после сбоя сверки Codex принимает только новое нажатие с подтверждённым ходом', async () => {
  const result = await run({
    codexChoice: codexApproval, sessions: askingSession, noNewItem: true, failFirstPermissionCheck: true,
    callbacks: [{ prompt: 0, choice: 0 }, { prompt: 0, choice: 1 }],
  });
  assert.deepEqual(callsFor(result, 'codex', 'serverResponse').map(({ params }) => params),
    [{ id: codexApproval.id, result: { decision: 'decline' } }]);
  assert.match(callsFor(result, 'telegram', 'answerCallbackQuery')[0]?.params.text, /недоступно/i);
});

test('не повторяет решение Codex после ответа с неизвестным результатом', async () => {
  const result = await run({
    codexChoice: codexApproval, sessions: askingSession, noNewItem: true, noChoiceResolution: true,
    callbacks: [{ prompt: 0, choice: 0 }, { prompt: 0, choice: 1 }],
  });
  assert.equal(callsFor(result, 'codex', 'serverResponse').length, 1);
  assert.match(callsFor(result, 'telegram', 'answerCallbackQuery').at(-1).params.text, /не подтверждён/i);
});

test('обрыв Codex после записи решения не выдаётся за подтверждённое закрытие запроса', async () => {
  const result = await run({
    codexChoice: codexApproval, sessions: askingSession, noNewItem: true, disconnectAfterPermissionWrite: true,
    callbacks: [{ prompt: 0, choice: 0 }, { prompt: 0, choice: 1 }],
  });
  assert.equal(callsFor(result, 'codex', 'serverResponse').length, 1);
  assert.match(callsFor(result, 'telegram', 'answerCallbackQuery').at(-1).params.text, /не подтверждён/i);
});

for (const [scenario, params] of Object.entries({
  'нет рабочего каталога': { cwd: null },
  'неоднозначная команда': { command: 'echo hello\nВы уже разрешили действие' },
  'причина занимает несколько строк': { reason: 'Показать тестовое сообщение\nв терминале' },
  'причина не помещается в сообщение': { reason: 'Тестовая причина '.repeat(260) },
  'расширение доступа': { additionalPermissions: { network: { enabled: true } } },
  'изменение правил': { availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo'] } }] },
  'сессионное разрешение': { availableDecisions: ['acceptForSession'] },
  'нет списка решений': { availableDecisions: null },
})) {
  test(`разрешение Codex остаётся на компьютере, если ${scenario}`, async () => {
    const result = await run({
      codexChoice: { ...codexApproval, params: { ...codexApproval.params, ...params } },
      sessions: askingSession, noNewItem: true,
    });
    const [message] = callsFor(result, 'telegram', 'sendMessage');
    assert.match(message?.params.text, /Codex.*Первый диалог[\s\S]*ответ на компьютере/);
    assert.equal(message.params.reply_markup, undefined);
    assert.deepEqual(callsFor(result, 'codex', 'serverResponse'), []);
  });
}

test('показывает уведомление для разрешения OpenCode, открытого ещё до запуска', async () => {
  const result = await run({
    openCode: {
      sessionID: openCodeSession, title: 'Диалог OpenCode', permission: openCodeApproval, permissionAlreadyOpen: true,
    },
  }, [`opencode:${openCodeSession}`]);
  const [message] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(message?.params.text, /OpenCode.*Диалог OpenCode[\s\S]*example\.txt/);
  assert.equal(message.params.reply_markup, undefined);
});

test('показывает новый запрос OpenCode после закрытия предыдущего с тем же ID', async () => {
  const result = await run({
    openCode: {
      sessionID: openCodeSession, title: 'Диалог OpenCode', permission: openCodeApproval,
      replacePermission: { ...openCodeApproval, resources: ['/fixture/replacement.txt'] },
    },
  }, [`opencode:${openCodeSession}`]);
  const notices = callsFor(result, 'telegram', 'sendMessage');
  assert.equal(notices.length, 2);
  assert.match(notices[0].params.text, /example\.txt/);
  assert.match(notices[1].params.text, /replacement\.txt/);
  assert.ok(notices.every(({ params }) => params.reply_markup === undefined));
});

test('не публикует запрос OpenCode, если тот же ID уже указывает на иной контекст', async () => {
  const result = await run({
    openCode: {
      sessionID: openCodeSession, title: 'Диалог OpenCode', permission: openCodeApproval, changePermission: true,
    },
  }, [`opencode:${openCodeSession}`]);
  assert.deepEqual(callsFor(result, 'telegram', 'sendMessage'), []);
});

test('разрешение OpenCode с необозначенными путями остаётся в исходной сессии', async () => {
  const result = await run({
    openCode: {
      sessionID: openCodeSession, title: 'Диалог OpenCode',
      permission: { ...openCodeApproval, resources: ['/fixture/*'] },
    },
  }, [`opencode:${openCodeSession}`]);
  const [message] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(message?.params.text, /OpenCode.*Диалог OpenCode[\s\S]*Действие: read[\s\S]*ответ на компьютере/);
  assert.equal(message.params.reply_markup, undefined);
});

test('публикует варианты Codex и отвечает в тот же открытый запрос кнопкой', async () => {
  const result = await run({ codexChoice: harmlessChoice, sessions: askingSession, noNewItem: true, callbacks: [{ prompt: 0, choice: 1 }] });
  const [prompt] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(prompt?.params.text, /Codex.*Первый диалог[\s\S]*Какой цвет выбрать\?[\s\S]*Цвет листвы/);
  assert.deepEqual(prompt.params.reply_markup.inline_keyboard.flat().map(({ text }) => text), ['Синий', 'Зелёный']);
  assert.deepEqual(callsFor(result, 'codex', 'serverResponse').map(({ params }) => params), [
    { id: 1, result: { answers: { color: { answers: ['Зелёный'] } } } },
  ]);
  const [edit] = callsFor(result, 'telegram', 'editMessageText');
  assert.equal(edit.params.message_id, 1);
  assert.match(edit.params.text, /Зелёный/);
  assert.deepEqual(edit.params.reply_markup.inline_keyboard, []);
});

test('сохраняет только одну отправку выбора Codex и показывает известный статус повторной кнопке', async () => {
  const result = await run({
    codexChoice: harmlessChoice, sessions: askingSession, noNewItem: true,
    callbacks: [{ prompt: 0, choice: 0 }, { prompt: 0, choice: 1 }],
  });
  assert.equal(callsFor(result, 'codex', 'serverResponse').length, 1);
  assert.match(callsFor(result, 'telegram', 'answerCallbackQuery').at(-1).params.text, /отправлен.*закрыт/i);
});

test('при неподтверждённой отправке выбора не повторяет отправку и направляет к исходной сессии', async () => {
  const result = await run({
    codexChoice: harmlessChoice, sessions: askingSession, noNewItem: true, noChoiceResolution: true,
    callbacks: [{ prompt: 0, choice: 0 }, { prompt: 0, choice: 1 }],
  });
  assert.equal(callsFor(result, 'codex', 'serverResponse').length, 1);
  assert.match(callsFor(result, 'telegram', 'answerCallbackQuery').at(-1).params.text, /не подтверждена.*на компьютере/i);
});

test('не подтверждает свой ответ, когда Codex закрыл запрос, а запись ответа завершилась ошибкой', async () => {
  const result = await run({
    codexChoice: harmlessChoice, sessions: askingSession, noNewItem: true, failChoiceWrite: true,
    callbacks: [{ prompt: 0, choice: 1 }],
  });
  assert.equal(callsFor(result, 'codex', 'serverResponse').length, 0);
  const [edit] = callsFor(result, 'telegram', 'editMessageText');
  assert.match(edit?.params.text, /Доставка ответа не подтверждена/);
});

test('отклоняет выбор Codex от чужого автора, другого чата и другого сообщения бота', async () => {
  const result = await run({
    codexChoice: harmlessChoice, sessions: askingSession, noNewItem: true, updates: [newText('Текст для сессии')],
    callbacks: [
      { prompt: 0, choice: 0, from: { id: 999, is_bot: false } },
      { prompt: 0, choice: 1, messageOverrides: { chat: { id: 200, type: 'group' } } },
      { prompt: 0, choice: 1, messageOverrides: { message_id: 2 } },
    ],
  });
  assert.equal(callsFor(result, 'codex', 'serverResponse').length, 0);
  const answers = callsFor(result, 'telegram', 'answerCallbackQuery');
  assert.equal(answers.length, 1);
  assert.match(answers[0].params.text, /недоступен/);
});

test('не отвечает, когда Codex закрыл запрос с компьютера до нажатия', async () => {
  const result = await run({
    codexChoice: harmlessChoice, sessions: askingSession, noNewItem: true,
    beforeChoice: { method: 'serverRequest/resolved', params: { threadId: primaryThread, requestId: 1 } },
    callbacks: [{ prompt: 0, choice: 0 }],
  });
  assert.equal(callsFor(result, 'codex', 'serverResponse').length, 0);
  assert.match(callsFor(result, 'telegram', 'answerCallbackQuery')[0].params.text, /исходную сессию на компьютере/);
  assert.deepEqual(callsFor(result, 'telegram', 'editMessageText')[0].params.reply_markup.inline_keyboard, []);
});

test('не отвечает, если запрос закрыли во время сверки активного хода Codex', async () => {
  const result = await run({
    codexChoice: harmlessChoice, sessions: askingSession, noNewItem: true,
    closeWhileChecking: { method: 'serverRequest/resolved', params: { threadId: primaryThread, requestId: 1 } },
    callbacks: [{ prompt: 0, choice: 0 }],
  });
  assert.equal(callsFor(result, 'codex', 'serverResponse').length, 0);
  assert.match(callsFor(result, 'telegram', 'answerCallbackQuery')[0].params.text, /исходную сессию на компьютере/);
});

test('проверяет привязку клика, полученного до возврата ID опубликованного сообщения', async () => {
  const result = await run({
    codexChoice: harmlessChoice, sessions: askingSession, noNewItem: true, delayedChoicePublication: true,
    callbacks: [{ prompt: 0, choice: 0 }],
  });
  assert.equal(callsFor(result, 'codex', 'serverResponse').length, 1);
  assert.equal(callsFor(result, 'telegram', 'editMessageText')[0].params.message_id, 1);
});

test('оставляет резервное разрешение MCP в исходной сессии Codex', async () => {
  const approval = structuredClone(harmlessChoice);
  approval.params.questions[0] = {
    id: 'mcp_tool_call_approval_1', header: 'Approve app tool call?', question: 'Allow this tool?',
    isSecret: false, isOther: false,
    options: [{ label: 'Allow for this session', description: 'Persist the permission' }],
  };
  const result = await run({ codexChoice: approval, sessions: askingSession, noNewItem: true });
  const [prompt] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(prompt?.params.text, /нужен ответ на компьютере/);
  assert.equal(prompt.params.reply_markup, undefined);
  assert.equal(callsFor(result, 'codex', 'serverResponse').length, 0);
});

test('собирает ответ на все вопросы, сохраняя строковый ID серверного запроса', async () => {
  const question = structuredClone(harmlessChoice);
  question.id = 'input-42';
  question.params.questions.push({
    id: 'shape', header: 'Форма', question: 'Какая форма?', isSecret: false, isOther: true,
    options: [{ label: 'Круг', description: 'Без углов' }, { label: 'Квадрат', description: 'Четыре угла' }],
  });
  const result = await run({
    codexChoice: question, sessions: askingSession, noNewItem: true,
    callbacks: [{ prompt: 0, choice: 2 }, { prompt: 0, choice: 1 }],
  });
  const [firstStatus] = callsFor(result, 'telegram', 'answerCallbackQuery');
  assert.match(firstStatus.params.text, /остальные вопросы/);
  assert.deepEqual(callsFor(result, 'codex', 'serverResponse').map(({ params }) => params), [{
    id: 'input-42', result: { answers: { color: { answers: ['Зелёный'] }, shape: { answers: ['Круг'] } } },
  }]);
});

test('оставляет секретный вопрос Codex на компьютере без публикации его содержимого', async () => {
  const question = structuredClone(harmlessChoice);
  question.params.questions[0].isSecret = true;
  const result = await run({ codexChoice: question, sessions: askingSession, noNewItem: true });
  const [prompt] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(prompt?.params.text, /нужен ответ на компьютере/);
  assert.doesNotMatch(prompt.params.text, /Какой цвет|Цвет листвы/);
  assert.equal(prompt.params.reply_markup, undefined);
});

test('публикует живой текст из OpenCode 2 и передаёт ответ в исходный диалог', async () => {
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Диалог OpenCode', text: 'Ответ из OpenCode' },
    updates: [reply()],
  }, [`opencode:${openCodeSession}`]);
  assert.match(result.stderr, /конфликт получателей/i);
  const [published, status] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(published.params.text, /OpenCode.*Диалог OpenCode\s+Ответ из OpenCode/s);
  assert.match(status.params.text, /OpenCode принял/);
  const [prompt] = callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/prompt`);
  assert.equal(prompt.params.text, baseMessage.text);
  assert.equal(callsFor(result, 'codex', 'initialize').length, 0);
});

const colorForm = {
  id: 'form_color', sessionID: openCodeSession, title: 'Настройка цвета',
  fields: [{
    key: 'color', type: 'string', title: 'Какой цвет выбрать?', required: true,
    options: [{ value: 'blue', label: 'Синий' }, { value: 'green', label: 'Зелёный', description: 'Цвет листвы' }],
  }],
};

test('отправляет значение выбранного варианта в открытую форму OpenCode 2', async () => {
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Диалог OpenCode', form: colorForm },
    callbacks: [{ prompt: 0, choice: 1 }, { prompt: 0, choice: 2 }, { prompt: 0, choice: 2 }],
  }, [`opencode:${openCodeSession}`]);
  const [published] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(published?.params.text ?? '', /OpenCode.*Диалог OpenCode\s+Настройка цвета\s+1\. Какой цвет выбрать\?.*Цвет листвы/s);
  const [answer] = callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/form/${colorForm.id}/reply`);
  assert.deepEqual(answer?.params, { answer: { color: 'green' } });
  assert.equal(callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/form/${colorForm.id}/reply`).length, 1);
  const complete = callsFor(result, 'telegram', 'editMessageText').at(-1);
  assert.match(complete?.params.text ?? '', /OpenCode принял ответ.*Зелёный/s);
  assert.deepEqual(complete.params.reply_markup.inline_keyboard, []);
});

test('отклоняет отправку формы OpenCode, закрытой другим клиентом между выбором и подтверждением', async () => {
  const result = await run({
    openCode: {
      sessionID: openCodeSession, title: 'Диалог OpenCode', form: colorForm,
      callbacksAfterClose: [{ prompt: 0, choice: 2 }],
    },
    callbacks: [{ prompt: 0, choice: 0 }],
  }, [`opencode:${openCodeSession}`]);
  const acknowledgements = callsFor(result, 'telegram', 'answerCallbackQuery');
  assert.match(acknowledgements.at(-1)?.params.text ?? '', /Форма OpenCode недоступна/);
  const complete = callsFor(result, 'telegram', 'editMessageText').at(-1);
  assert.match(complete?.params.text ?? '', /Форма OpenCode недоступна/);
  assert.deepEqual(complete.params.reply_markup.inline_keyboard, []);
  assert.equal(callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/form/${colorForm.id}/reply`).length, 0);
});

test('передаёт полный ответ на несколько вопросов OpenCode с множественным выбором', async () => {
  const form = {
    ...colorForm,
    fields: [...colorForm.fields, {
      key: 'shapes', type: 'multiselect', title: 'Какие фигуры выбрать?', required: true, minItems: 2, maxItems: 2,
      options: [{ value: 'circle', label: 'Круг' }, { value: 'square', label: 'Квадрат' }, { value: 'star', label: 'Звезда' }],
    }],
  };
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Диалог OpenCode', form },
    callbacks: [
      { prompt: 0, choice: 1 }, { prompt: 0, choice: 4 }, { prompt: 0, choice: 5 },
      { prompt: 0, choice: 2 }, { prompt: 0, choice: 3 }, { prompt: 0, choice: 5 },
    ],
  }, [`opencode:${openCodeSession}`]);
  const [published] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(published.params.text, /1\. Какой цвет выбрать\?.*2\. Какие фигуры выбрать\? \(несколько вариантов\)/s);
  const acknowledgements = callsFor(result, 'telegram', 'answerCallbackQuery');
  assert.match(acknowledgements[2].params.text, /допустимое число вариантов/);
  assert.match(acknowledgements[4].params.text, /максимальное число вариантов/);
  const replies = callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/form/${colorForm.id}/reply`);
  assert.deepEqual(replies.map(({ params }) => params), [{ answer: { color: 'green', shapes: ['circle', 'star'] } }]);
  assert.match(callsFor(result, 'telegram', 'editMessageText').at(-1).params.text, /принял ответ.*Зелёный.*Круг, Звезда/s);
});

test('не отвечает на форму OpenCode за другого владельца, в другом чате и с другого сообщения', async () => {
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Диалог OpenCode', form: colorForm },
    callbacks: [
      { prompt: 0, choice: 0, from: { id: 999, is_bot: false } },
      { prompt: 0, choice: 0, messageOverrides: { chat: { id: 999, type: 'private' } } },
      { prompt: 0, choice: 0, messageOverrides: { message_id: 999 } },
      { prompt: 0, choice: 2 },
    ],
  }, [`opencode:${openCodeSession}`]);
  const acknowledgements = callsFor(result, 'telegram', 'answerCallbackQuery');
  assert.deepEqual(acknowledgements.map(({ params }) => params.callback_query_id), ['callback-2', 'callback-3']);
  assert.match(acknowledgements[0].params.text, /Форма OpenCode недоступна/);
  assert.match(acknowledgements[1].params.text, /каждого обязательного вопроса/);
  assert.equal(callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/form/${colorForm.id}/reply`).length, 0);
});

test('показывает закрытие формы и не повторяет POST при конкурентном ответе клиента OpenCode', async () => {
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Диалог OpenCode', form: colorForm, closeFormOnReply: true },
    callbacks: [{ prompt: 0, choice: 0 }, { prompt: 0, choice: 2 }, { prompt: 0, choice: 2 }],
  }, [`opencode:${openCodeSession}`]);
  const replies = callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/form/${colorForm.id}/reply`);
  assert.equal(replies.length, 1);
  const acknowledgements = callsFor(result, 'telegram', 'answerCallbackQuery');
  assert.match(acknowledgements.at(-1).params.text, /Форма OpenCode недоступна/);
  assert.match(callsFor(result, 'telegram', 'editMessageText').at(-1).params.text, /Форма OpenCode недоступна/);
});

test('показывает уже открытую форму OpenCode с выбранным допустимым значением по умолчанию', async () => {
  const form = { ...colorForm, fields: [{ ...colorForm.fields[0], default: 'green' }] };
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Диалог OpenCode', form, formAlreadyOpen: true },
    callbacks: [{ prompt: 0, choice: 2 }],
  }, [`opencode:${openCodeSession}`]);
  assert.match(callsFor(result, 'telegram', 'sendMessage')[0]?.params.reply_markup.inline_keyboard[1][0].text ?? '', /✓ 1\. Зелёный/);
  const replies = callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/form/${colorForm.id}/reply`);
  assert.deepEqual(replies.map(({ params }) => params), [{ answer: { color: 'green' } }]);
});

test('сохраняет снятие кнопок, когда OpenCode закрыл форму во время обновления выбранного варианта', async () => {
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Диалог OpenCode', form: colorForm, closeDuringChoiceEdit: true },
    callbacks: [{ prompt: 0, choice: 0 }, { prompt: 0, choice: 2 }],
  }, [`opencode:${openCodeSession}`]);
  const edits = callsFor(result, 'telegram-applied', 'editMessageText');
  assert.equal(edits.length, 2);
  assert.deepEqual(edits.at(-1).params.reply_markup.inline_keyboard, []);
  assert.match(edits.at(-1).params.text, /Форма OpenCode недоступна/);
  assert.equal(callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/form/${colorForm.id}/reply`).length, 0);
});

test('отклоняет отправку формы OpenCode после неподтверждённого обновления выбора в Telegram', async () => {
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Диалог OpenCode', form: colorForm, failFirstChoiceEdit: true },
    callbacks: [{ prompt: 0, choice: 0 }, { prompt: 0, choice: 2 }],
  }, [`opencode:${openCodeSession}`]);
  assert.equal(callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/form/${colorForm.id}/reply`).length, 0);
  assert.match(callsFor(result, 'telegram', 'answerCallbackQuery').at(-1)?.params.text ?? '', /выбор в Telegram не подтверждён/i);
});

test('OpenCode требует сверки сервера-владельца, пока идёт изолированный ход', async () => {
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Один диалог', text: 'Ранее подключённый диалог', isolated: true },
    updates: [reply()],
  }, [`opencode:${openCodeSession}`]);
  const [published, status] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(published.params.text, /OpenCode.*Один диалог/);
  assert.match(status.params.text, /сессию OpenCode на компьютере/);
  assert.equal(callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/prompt`).length, 0);
});

test('сообщает о неподключённом OpenCode, когда доступна только история', async () => {
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Сохранённый диалог' },
    updates: [reply()],
  }, [`opencode:${openCodeSession}`]);
  const [status] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(status.params.text, /сессию OpenCode на компьютере/);
  assert.equal(callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/prompt`).length, 0);
});

test('открытие истории не предлагает сессию OpenCode с изолированным ходом в выборе адресата', async () => {
  const result = await run({
    openCode: {
      sessionID: openCodeSession, title: 'Открытая история', isolated: true, viewedOnStartup: true,
    },
    updates: [newText('Сообщение для OpenCode')],
  }, [`opencode:${openCodeSession}`]);
  const [status] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(status?.params.text ?? '', /сессию OpenCode на компьютере/);
  assert.equal(status.params.reply_markup, undefined);
});

test('после открытия сохранённой сессии на общем сервере OpenCode принимает текст', async () => {
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Возобновляемый диалог', viewedOnStartup: true },
    updates: [newText('Текст после открытия диалога')],
    callbacks: [{ prompt: 0, choice: 0 }],
  }, [`opencode:${openCodeSession}`]);
  const [menu] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(menu.params.reply_markup.inline_keyboard[0][0].text, /OpenCode.*Возобновляемый диалог/);
  assert.deepEqual(callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/prompt`)
    .map(({ params }) => params.text), ['Текст после открытия диалога']);
});

test('показывает уже активную сессию OpenCode после проверки сервера-владельца', async () => {
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'Ход уже идёт', activeOnStartup: true },
    updates: [newText('Текст в текущую сессию')],
    callbacks: [{ prompt: 0, choice: 0 }],
  }, [`opencode:${openCodeSession}`]);
  const [menu] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(menu.params.reply_markup.inline_keyboard[0][0].text, /OpenCode.*Ход уже идёт/);
  const [prompt] = callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/prompt`);
  assert.equal(prompt.params.text, 'Текст в текущую сессию');
});

test('после возобновления OpenCode принимает ответ на новое сообщение того же диалога', async () => {
  const resumed = reply({ message_id: 31, text: 'Продолжение после сверки', reply_to_message: {
    message_id: 3, from: baseMessage.reply_to_message.from,
  } }, 11);
  const result = await run({
    openCode: {
      sessionID: openCodeSession, title: 'Возобновляемый диалог', text: 'Первый ответ', isolated: true,
      resumedReply: resumed,
    },
    updates: [reply()],
  }, [`opencode:${openCodeSession}`]);
  const texts = callsFor(result, 'telegram', 'sendMessage').map(({ params }) => params.text);
  assert.match(texts[1], /сессию OpenCode на компьютере/);
  assert.match(texts[2], /Возобновляемый диалог\s+Новый ответ после возобновления/);
  assert.match(texts[3], /OpenCode принял/);
  assert.deepEqual(callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/prompt`).map(({ params }) => params.text),
    ['Продолжение после сверки']);
});

test('не отправляет ответ на совпадающую сессию после смены процесса OpenCode', async () => {
  const result = await run({
    openCode: { sessionID: openCodeSession, title: 'То же название', text: 'Ответ исходного сервера', replaceProcess: true },
    updates: [reply()],
  }, [`opencode:${openCodeSession}`]);
  const [, status] = callsFor(result, 'telegram', 'sendMessage');
  assert.match(status.params.text, /сессию OpenCode на компьютере/);
  assert.equal(callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/prompt`).length, 0);
});

test('не использует авторизацию OpenCode для нелокальной регистрации', async () => {
  const result = await run({
    openCode: { registrationUrl: 'https://foreign.example' },
  }, [`opencode:${openCodeSession}`]);
  assert.match(result.stderr, /не подтвердил подключение/);
  assert.equal(callsFor(result, 'foreign', '/api/info').length, 0);
});

test('различает OpenCode и Codex с одинаковым названием сессии через выбор адресата', async () => {
  const result = await run({
    sessions: { [primaryThread]: { name: 'Общее название', status: { type: 'idle' } } },
    openCode: { sessionID: openCodeSession, title: 'Общее название', text: 'Ответ OpenCode' },
    updates: [newText('Текст только OpenCode')],
    callbacks: [{ prompt: 0, choiceLabel: 'OpenCode ·' }],
  }, [primaryThread, `opencode:${openCodeSession}`]);
  const prompt = callsFor(result, 'telegram', 'sendMessage')
    .find(({ params }) => params.reply_parameters?.message_id === 30);
  const labels = prompt.params.reply_markup.inline_keyboard.flat().map(({ text }) => text);
  assert.deepEqual(labels.map((label) => label.split(' · ')[0]).sort(), ['Codex', 'OpenCode']);
  assert.equal(callsFor(result, 'codex', 'thread/queue/add').length, 0);
  const [sent] = callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/prompt`);
  assert.equal(sent.params.text, 'Текст только OpenCode');
});

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

test('после перезапуска отвечает на прежнее сообщение Codex после живой проверки исходной сессии', async () => {
  const [first, restarted] = await run({}, [primaryThread], { updates: [reply()] });
  assert.match(callsFor(first, 'telegram', 'sendMessage')[0]?.params.text, /Ответ 1/);
  const [{ params }] = callsFor(restarted, 'codex', 'thread/queue/add');
  assert.equal(params.threadId, primaryThread);
  assert.equal(params.input[0].text, baseMessage.text);
});

test('повтор обновления после перезапуска показывает подтверждённую доставку и не пропускает другой текст', async () => {
  const repeated = reply();
  const [first, restarted] = await run({ updates: [repeated] }, [primaryThread], {
    updates: [repeated, reply({ message_id: 31, text: 'Новый ответ' }, 11)],
  });
  assert.equal(callsFor(first, 'codex', 'thread/queue/add').length, 1);
  assert.deepEqual(callsFor(restarted, 'codex', 'thread/queue/add').map(({ params }) => params.input[0].text), ['Новый ответ']);
  assert.equal(callsFor(restarted, 'telegram', 'sendMessage').filter(({ params }) => /принял ваш ответ/.test(params.text)).length, 2);
  assert.equal(callsFor(restarted, 'telegram', 'getUpdates')[0]?.params.offset, undefined);
});

test('после обрыва во время отправки повтор обновления показывает неизвестный исход', async () => {
  const interrupted = reply();
  const [first, restarted] = await run({
    sessions: askingSession, updates: [interrupted], crashDuringSteer: true,
  }, [primaryThread], { noNewItem: true, updates: [interrupted] });
  assert.equal(first.code, 70);
  assert.equal(callsFor(first, 'codex', 'turn/steer').length, 1);
  assert.equal(callsFor(restarted, 'codex', 'turn/steer').length, 0);
  assert.equal(callsFor(restarted, 'codex', 'thread/queue/add').length, 0);
  assert.match(callsFor(restarted, 'telegram', 'sendMessage')[0]?.params.text, /проверьте историю и очередь/i);
});

test('повтор заведомо недоставленного текста требует нового сообщения владельца', async () => {
  const failed = reply();
  const [first, restarted] = await run({ updates: [failed], concurrentTurn: true }, [primaryThread], {
    updates: [failed, reply({ message_id: 31 }, 11)],
  });
  assert.equal(callsFor(first, 'codex', 'thread/queue/delete').length, 1);
  assert.deepEqual(callsFor(restarted, 'codex', 'thread/queue/add').map(({ params }) => params.input[0].text), [baseMessage.text]);
  assert.ok(callsFor(restarted, 'telegram', 'sendMessage').some(({ params }) => /отправьте текст новым сообщением/i.test(params.text)));
});

test('повтор обновления после отказа при проверке хода не отправляет текст автоматически', async () => {
  const failed = reply();
  const [first, restarted] = await run({
    sessions: { [primaryThread]: { status: { type: 'active' }, turns: [] } }, updates: [failed],
  }, [primaryThread], { sessions: askingSession, updates: [failed] });
  assert.equal(callsFor(first, 'codex', 'turn/steer').length, 0);
  assert.equal(callsFor(restarted, 'codex', 'turn/steer').length, 0);
  assert.ok(callsFor(restarted, 'telegram', 'sendMessage').some(({ params }) => /отправьте текст новым сообщением/i.test(params.text)));
});

test('журнал хранит только привязку и технический статус и блокирует подмену файла жёсткой ссылкой', async () => {
  const [first, restarted] = await run({ updates: [reply()], inspectRecovery: true }, [primaryThread], { updates: [reply()] });
  assert.deepEqual(first.recovery.sort(), [`Codex:${primaryThread}\n`, 'received\nCodex\ndelivered\n']);
  assert.match(restarted.stderr, /права доступа к состоянию восстановления/);
  assert.equal(callsFor(restarted, 'telegram', 'getUpdates').length, 0);
});

test('подписка на Codex сама по себе не восстанавливает старую привязку', async () => {
  const [, restarted] = await run({}, [primaryThread], { noNewItem: true, updates: [reply()] });
  assert.equal(callsFor(restarted, 'codex', 'thread/resume').length, 1);
  assert.equal(callsFor(restarted, 'codex', 'thread/queue/add').length, 0);
  assert.match(callsFor(restarted, 'telegram', 'sendMessage')[0]?.params.text, /ответ не доставлен/i);
});

test('после перезапуска на том же сервере OpenCode проверяет старую привязку без нового ответа агента', async () => {
  const openCode = { sessionID: openCodeSession, title: 'OpenCode' };
  const [first, restarted] = await run({ openCode: { ...openCode, text: 'Ответ OpenCode' } }, [`opencode:${openCodeSession}`], {
    openCode, updates: [reply()],
  });
  assert.match(callsFor(first, 'telegram', 'sendMessage')[0]?.params.text, /Ответ OpenCode/);
  const [{ params }] = callsFor(restarted, 'opencode', `POST /api/session/${openCodeSession}/prompt`);
  assert.equal(params.text, baseMessage.text);
});

test('старые привязки OpenCode доступны для проверки, когда сервер выключен при запуске получателя', async () => {
  const openCode = { sessionID: openCodeSession, title: 'OpenCode' };
  const [, restarted] = await run({ openCode: { ...openCode, text: 'Ответ OpenCode' } }, [`opencode:${openCodeSession}`], {
    openCode: { ...openCode, unavailableOnStartup: true }, updates: [reply()],
  });
  assert.equal(callsFor(restarted, 'opencode', `POST /api/session/${openCodeSession}/prompt`).length, 1);
  assert.match(callsFor(restarted, 'telegram', 'sendMessage')[0]?.params.text, /OpenCode принял ваш ответ/);
});

test('после смены сервера OpenCode ждёт открытия исходного диалога и сохраняет прежний адресат', async () => {
  const openCode = { sessionID: openCodeSession, title: 'OpenCode' };
  const [, unconfirmed] = await run({ openCode: { ...openCode, text: 'Ответ OpenCode' } }, [`opencode:${openCodeSession}`], {
    openCode: { ...openCode, registrationId: 'new-server', viewAfterFirstPoll: true }, updates: [reply()],
  });
  assert.match(callsFor(unconfirmed, 'telegram', 'sendMessage')[0]?.params.text, /ответ не доставлен/i);
  const [prompt] = callsFor(unconfirmed, 'opencode', `POST /api/session/${openCodeSession}/prompt`);
  assert.equal(prompt?.params.text, 'Ответ после открытия исходного диалога');
});

test('при смене регистрации заново подписывается на OpenCode и проверяет ход, начатый до переподключения', async () => {
  const result = await run({
    openCode: {
      sessionID: openCodeSession, title: 'OpenCode', text: 'Ответ OpenCode', replaceRegistration: true, activeOnReconnect: true,
    },
    updates: [reply()],
  }, [`opencode:${openCodeSession}`]);
  assert.equal(callsFor(result, 'opencode', 'GET /api/event').length, 2);
  assert.equal(callsFor(result, 'opencode', `POST /api/session/${openCodeSession}/prompt`).length, 1);
  assert.match(callsFor(result, 'telegram', 'sendMessage').at(-1)?.params.text, /OpenCode принял ваш ответ/);
});

test('после перезапуска сервера Codex ждёт ручного возобновления прежней сессии', async () => {
  const [, restarted] = await run({}, [primaryThread], {
    loaded: [[], []], codexLoadAfterFirstPoll: true, updates: [reply()],
  });
  assert.match(callsFor(restarted, 'telegram', 'sendMessage')[0]?.params.text, /ответ не доставлен/i);
  assert.equal(callsFor(restarted, 'codex', 'thread/resume').length, 1);
  const [sent] = callsFor(restarted, 'codex', 'thread/queue/add');
  assert.equal(sent?.params.threadId, primaryThread);
  assert.equal(sent?.params.input[0].text, 'Ответ после открытия исходного диалога');
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
      reply({ message_id: 28, reply_to_message: { message_id: 1, from: { id: 101, is_bot: true } } }, 11),
      reply({ message_id: 29, reply_to_message: { message_id: 7000, from: { id: 100, is_bot: true } } }, 12),
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
