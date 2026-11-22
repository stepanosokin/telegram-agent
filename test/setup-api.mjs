// Preloaded into the receiver process to substitute only its external APIs.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

const childProcess = createRequire(import.meta.url)('node:child_process');
const spawn = childProcess.spawn;
const scenario = JSON.parse(process.env.TELEGRAM_AGENT_SCENARIO);
const telegram = {
  bot: { id: 100, is_bot: true },
  chat: { id: 200, type: 'private' },
  ...scenario.telegram,
};
const threadIds = [
  '01900000-0000-7000-8000-000000000001',
  '01900000-0000-7000-8000-000000000002',
];
const sessions = scenario.sessions || {
  [threadIds[0]]: { name: 'Первый диалог', status: { type: 'idle' }, turns: [] },
};
let rpcCount = 0;
let updatesDelivered = false;
let sentCount = 0;

function record(channel, method, params) {
  process.send({ channel, method, params });
}

globalThis.fetch = async (url, options) => {
  const match = /^https:\/\/api\.telegram\.org\/bot100:fixture-not-a-secret\/([a-zA-Z]+)$/.exec(url);
  assert.ok(match, 'unexpected Telegram endpoint');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  const method = match[1];
  const params = JSON.parse(options.body);
  record('telegram', method, params);

  let result;
  switch (method) {
    case 'getMe':
      result = telegram.bot;
      break;
    case 'getChat':
      result = telegram.chat;
      break;
    case 'sendMessage':
      if (scenario.failStatus && sentCount > 0) {
        return new Response(JSON.stringify({ ok: false, error_code: 503 }), { status: 503 });
      }
      result = { message_id: ++sentCount, chat: telegram.chat };
      break;
    case 'getUpdates':
      if (updatesDelivered) {
        return new Response(JSON.stringify({ ok: false, error_code: 409 }), { status: 409 });
      }
      updatesDelivered = true;
      result = scenario.updates || [];
      break;
    default:
      throw new Error('Unexpected Telegram method');
  }
  return Response.json({ ok: true, result });
};

childProcess.spawn = (command, args, options) => {
  if (command !== 'codex') return spawn(command, args, options);
  assert.deepEqual(args, ['app-server', 'proxy']);
  const proxy = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill() {
      this.stdout.end();
    },
  });
  const emit = (packet) => proxy.stdout.write(JSON.stringify(packet) + '\n');
  proxy.stdin.on('data', (line) => {
    const { method, id, params } = JSON.parse(line);
    record('codex', method, params);
    const threadId = params?.threadId;
    const session = sessions[threadId];
    let result;
    switch (method) {
      case 'initialize':
        result = {};
        break;
      case 'initialized':
        return;
      case 'thread/loaded/list':
        rpcCount++;
        result = { data: scenario.loaded?.[rpcCount - 1] || Object.keys(sessions) };
        break;
      case 'thread/read':
        result = { thread: { id: threadId, ...session } };
        break;
      case 'thread/turns/list':
        result = { data: session?.turns || [] };
        break;
      case 'thread/resume':
        result = { thread: { id: threadId, ...session } };
        break;
      case 'thread/queue/add':
        if (scenario.autoQueueStart) {
          emit({ method: 'item/completed', params: { item: { type: 'userMessage' } } });
          emit({
            method: 'item/completed',
            params: {
              threadId,
              item: { type: 'userMessage', clientId: params.clientUserMessageId },
            },
          });
        }
        result = { queuedSubmission: { id: 'in-queue' } };
        break;
      case 'thread/queue/start':
        if (scenario.autoQueueStart) {
          emit({ id, error: { code: -32600, message: 'queued submission not found' } });
          return;
        }
        if (scenario.concurrentTurn) {
          emit({ id, error: { code: -32600, message: 'thread already has an active or pending turn' } });
          return;
        }
        result = { turn: { id: 'new-turn' } };
        break;
      case 'thread/queue/delete':
        result = { deleted: !scenario.autoQueueStart };
        break;
      case 'turn/steer':
        if (scenario.changedActiveTurn) {
          emit({ id, error: { code: -32600, message: 'expected turn no longer active' } });
          return;
        }
        if (scenario.steerDisconnect) {
          proxy.stdout.end();
          return;
        }
        result = { turnId: params.expectedTurnId };
        break;
      default:
        throw new Error('Unexpected App Server method: ' + method);
    }
    emit({ id, result });
    if (method === 'thread/resume' && session && !scenario.noNewItem) {
      const index = threadIds.indexOf(threadId) + 1;
      emit({
        method: 'item/completed',
        params: {
          threadId,
          item: { type: 'agentMessage', id: String(index), text: 'Ответ ' + index },
        },
      });
    }
  });
  return proxy;
};
syncBuiltinESMExports();
