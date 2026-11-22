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
let callbackTurnChecks = 0;
let polls = 0;
let sentCount = 0;
const prompts = [];
const { promise: codexChoicePublished, resolve: recordCodexChoice } = Promise.withResolvers();
const { promise: openCodePublished, resolve: recordOpenCodePublish } = Promise.withResolvers();
const { promise: openCodeViewRead, resolve: recordOpenCodeViewRead } = Promise.withResolvers();
let openCodePosts = 0;
let openCodeStream;
let openCodeProbes = 0;
let openCodeResumePublished;
let openCodeFormState = { status: 'pending' };
let openCodeChoiceEdits = 0;
let emitCodexPacket;
const openCodeEncoder = new TextEncoder();

function sendOpenCodeText(id, text) {
  const event = {
    type: 'session.text.ended', id: 'text-' + openCodePosts, created: Date.now(),
    durable: { aggregateID: id, seq: openCodePosts, version: 1 },
    data: { sessionID: id, assistantMessageID: 'fixture-assistant', ordinal: 0, text },
  };
  sendOpenCodeEvent(event);
}

function sendOpenCodeEvent(event) {
  openCodeStream.enqueue(openCodeEncoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}

function record(channel, method, params) {
  process.send({ channel, method, params });
}

globalThis.fetch = async (url, options) => {
  const target = new URL(url instanceof Request ? url.url : url);
  if (target.origin === 'https://foreign.example') {
    record('foreign', target.pathname);
    return new Response(null, { status: 404 });
  }
  if (target.origin === 'http://127.0.0.1:32123') {
    const headers = new Headers(options?.headers ?? (url instanceof Request ? url.headers : undefined));
    assert.equal(headers.get('authorization'), 'Basic ' + Buffer.from('opencode:fixture-not-a-secret').toString('base64'));
    const method = options?.method ?? (url instanceof Request ? url.method : 'GET');
    const body = options?.body ? JSON.parse(options.body) : method === 'POST' && url instanceof Request ? await url.json() : undefined;
    record('opencode', `${method} ${target.pathname}`, body);
    const { sessionID, title, text, isolated, form, permission } = scenario.openCode;
    if (target.pathname === '/api/info') {
      const pid = ++openCodeProbes >= 3 && scenario.openCode.replaceProcess ? 5678 : 1234;
      return Response.json({ pid, version: '2.3.2' });
    }
    if (target.pathname === '/api/event') {
      const signal = options?.signal ?? (url instanceof Request ? url.signal : undefined);
      const body = new ReadableStream({
        start(controller) {
          openCodeStream = controller;
          controller.enqueue(openCodeEncoder.encode('data: {"type":"server.connected","id":"connected","data":{}}\n\n'));
          if (text) sendOpenCodeText(sessionID, text);
          if (scenario.openCode.viewedOnStartup) sendOpenCodeEvent({
            type: 'session.viewed', id: 'viewed', created: 100,
            durable: { aggregateID: sessionID, seq: 1, version: 1 },
            data: { sessionID, idle: 50 },
          });
          if (form && !scenario.openCode.formAlreadyOpen) sendOpenCodeEvent({
            type: 'form.created', id: 'form-created', created: 1, data: { form },
          });
          if (permission && !scenario.openCode.permissionAlreadyOpen) sendOpenCodeEvent({
            type: 'permission.asked', id: 'permission-asked', created: 1, data: permission,
          });
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (target.pathname === '/api/session/active') {
      return Response.json({ data: scenario.openCode.activeOnStartup || openCodePosts > 1
        ? { [sessionID]: { type: 'running' } } : {} });
    }
    if (target.pathname === `/api/session/${sessionID}`) {
      recordOpenCodeViewRead();
      return Response.json({ data: { id: sessionID, title, time: isolated ? { busy: 100, idle: 50 } : {} } });
    }
    if (target.pathname === `/api/session/${sessionID}/prompt`) {
      if (!/^msg_/.test(body.id)) return Response.json({ _tag: 'InvalidRequestError', message: 'Expected a string starting with msg_' }, { status: 400 });
      return Response.json({ data: { sessionID, id: body.id } });
    }
    if (form && target.pathname === `/api/session/${sessionID}/form`) {
      return Response.json({ data: openCodeFormState.status === 'pending' ? [form] : [] });
    }
    if (form && target.pathname === `/api/session/${sessionID}/form/${form.id}`) {
      return Response.json({ data: { ...form, state: openCodeFormState } });
    }
    if (form && target.pathname === `/api/session/${sessionID}/form/${form.id}/reply`) {
      if (scenario.openCode.closeFormOnReply) openCodeFormState = { status: 'cancelled' };
      if (openCodeFormState.status !== 'pending') {
        return Response.json({ _tag: 'FormAlreadySettledError', id: form.id, message: 'Form already settled' }, { status: 409 });
      }
      openCodeFormState = { status: 'answered', answer: body.answer };
      sendOpenCodeEvent({
        type: 'form.replied', id: 'form-replied', created: 2,
        data: { id: form.id, sessionID, answer: body.answer },
      });
      return new Response(null, { status: 204 });
    }
    const permissionPath = `/api/session/${sessionID}/permission`;
    if (target.pathname === permissionPath) {
      return Response.json({ data: permission ? [permission] : [] });
    }
    if (permission && method === 'GET' && target.pathname === `${permissionPath}/${permission.id}`) {
      const changed = scenario.openCode.changePermission;
      return Response.json({ data: changed ? { ...permission, resources: ['/fixture/different.txt'] } : permission });
    }
    return new Response(null, { status: 404 });
  }
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
      if (scenario.codexChoice && !params.reply_parameters && params.text.startsWith('Codex ·')) recordCodexChoice();
      if (params.text.startsWith('OpenCode ·')) {
        openCodePosts++;
        recordOpenCodePublish();
        if (openCodePosts > 1) openCodeResumePublished?.();
      }
      if (params.reply_markup?.inline_keyboard.length) {
        const original = scenario.updates?.find(({ message }) => message?.message_id === params.reply_parameters?.message_id);
        prompts.push({
          message: { ...result, date: 1, from: telegram.bot, reply_to_message: original?.message },
          choices: params.reply_markup.inline_keyboard.flat(),
        });
        if (scenario.delayedChoicePublication && !params.reply_parameters) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      break;
    case 'editMessageText':
      if (scenario.openCode?.form && params.reply_markup.inline_keyboard.length && ++openCodeChoiceEdits === 1) {
        if (scenario.openCode.failFirstChoiceEdit) {
          return new Response(JSON.stringify({ ok: false, error_code: 503 }), { status: 503 });
        }
        if (scenario.openCode.closeDuringChoiceEdit) {
          const { form, sessionID } = scenario.openCode;
          openCodeFormState = { status: 'cancelled' };
          sendOpenCodeEvent({
            type: 'form.cancelled', id: 'form-cancelled', created: 2, data: { id: form.id, sessionID },
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      record('telegram-applied', method, params);
      result = true;
      break;
    case 'answerCallbackQuery':
      result = true;
      break;
    case 'getUpdates':
      if (++polls === 1) {
        if (scenario.codexChoice) {
          let deadline;
          await Promise.race([codexChoicePublished, new Promise((resolve) => { deadline = setTimeout(resolve, 1000); })]);
          clearTimeout(deadline);
        }
        if (scenario.openCode?.text || scenario.openCode?.form || scenario.openCode?.permission) {
          let deadline;
          await Promise.race([openCodePublished, new Promise((resolve) => { deadline = setTimeout(resolve, 1500); })]);
          clearTimeout(deadline);
        }
        if (scenario.openCode?.viewedOnStartup) await openCodeViewRead;
        result = scenario.updates || [];
      } else if (polls === 2 && scenario.openCode?.resumedReply) {
        const { promise, resolve } = Promise.withResolvers();
        openCodeResumePublished = resolve;
        sendOpenCodeText(scenario.openCode.sessionID, 'Новый ответ после возобновления');
        await promise;
        result = [scenario.openCode.resumedReply];
      } else if (polls === 2 && scenario.callbacks) {
        if (scenario.beforeChoice) emitCodexPacket(scenario.beforeChoice);
        result = scenario.callbacks.map((callback, index) => makeCallback(callback, index));
      } else if (polls === 3 && scenario.openCode?.callbacksAfterClose) {
        const { sessionID, form } = scenario.openCode;
        openCodeFormState = { status: 'cancelled' };
        sendOpenCodeEvent({
          type: 'form.cancelled', id: 'form-cancelled', created: 2, data: { id: form.id, sessionID },
        });
        result = scenario.openCode.callbacksAfterClose.map((callback, index) => makeCallback(callback, 100 + index));
      } else {
        return new Response(JSON.stringify({ ok: false, error_code: 409 }), { status: 409 });
      }
      break;
    default:
      throw new Error('Unexpected Telegram method');
  }
  return Response.json({ ok: true, result });
};

function makeCallback({ prompt, choice, tokenFrom = prompt, messageOverrides, ...overrides }, index) {
  return {
    update_id: 100 + index,
    callback_query: {
      id: `callback-${index}`,
      from: { id: 300, is_bot: false },
      message: { ...prompts[prompt]?.message, ...messageOverrides },
      data: prompts[tokenFrom]?.choices[choice]?.callback_data,
      ...overrides,
    },
  };
}

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
  emitCodexPacket = emit;
  if (scenario.failChoiceWrite) {
    const originalWrite = proxy.stdin._write.bind(proxy.stdin);
    proxy.stdin._write = (chunk, encoding, callback) => {
      const packet = JSON.parse(chunk);
      if (!packet.method && packet.result) {
        emit({ method: 'serverRequest/resolved', params: { threadId: scenario.codexChoice.params.threadId, requestId: packet.id } });
        queueMicrotask(() => callback(new Error('fixture write failure')));
        return;
      }
      originalWrite(chunk, encoding, callback);
    };
  }
  proxy.stdin.on('data', (line) => {
    const { method, id, params, result: clientResult } = JSON.parse(line);
    if (!method && clientResult && scenario.codexChoice) {
      record('codex', 'serverResponse', { id, result: clientResult });
      if (scenario.disconnectAfterPermissionWrite) {
        queueMicrotask(() => proxy.stdout.end());
      } else if (!scenario.noChoiceResolution) {
        emit({ method: 'serverRequest/resolved', params: { threadId: scenario.codexChoice.params.threadId, requestId: id } });
      }
      return;
    }
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
        if (scenario.failFirstPermissionCheck && polls >= 2 && ++callbackTurnChecks === 1) {
          emit({ id, error: { code: -32603, message: 'Temporary fixture error' } });
          return;
        }
        if (scenario.closeWhileChecking && polls >= 2) emit(scenario.closeWhileChecking);
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
    if (method === 'thread/resume' && scenario.codexChoice?.params.threadId === threadId) {
      emit(scenario.codexChoice);
    }
    if (method === 'thread/resume' && session && !scenario.noNewItem && !scenario.withoutItem?.includes(threadId)) {
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
