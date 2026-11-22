// Preloaded into the receiver process to substitute only its external APIs.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { connect } from 'node:net';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

const childProcess = createRequire(import.meta.url)('node:child_process');
const spawn = childProcess.spawn;
const execFile = childProcess.execFile;
const scenario = JSON.parse(process.env.TELEGRAM_AGENT_SCENARIO);
const inspectProcess = (...args) => execFile(...args);
inspectProcess[promisify.custom] = (...args) => {
  const evidence = args[2]?.env;
  if (scenario.scheduler) {
    if (evidence?.TELEGRAM_AGENT_TASK_NAME || args[0] === 'systemctl') {
      record('scheduler', args[0] === 'systemctl' ? args[1][1] : evidence.TELEGRAM_AGENT_TASK_MODE);
      return Promise.resolve({ stdout: '' });
    }
    if (args[0] === 'loginctl') {
      record('login', args[1][0]);
      if (args[1][0] === 'show-user') {
        return readFile(join(process.env.HOME, 'login-state'), 'utf8')
          .then((stdout) => ({ stdout }), () => ({ stdout: '' }));
      }
      return Promise.resolve({ stdout: `User=${process.getuid()}\nClass=user\nState=active\n` });
    }
  }
  if (scenario.codexIdentity && evidence?.TELEGRAM_AGENT_CODEX_PID && evidence.TELEGRAM_AGENT_CODEX_SOCKET) {
    const socketTimestamp = 170000000000001000n + BigInt(scenario.codexIdentity);
    return Promise.resolve({ stdout: ['170000000000000000', socketTimestamp, '0000000000000123'].join('\r\n') });
  }
  return execFile[promisify.custom](...args);
};
childProcess.execFile = inspectProcess;
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
let recoveredPrompt;
const previousPrompt = scenario.previousPrompt && {
  message: { message_id: 1, chat: telegram.chat, date: 1, from: telegram.bot },
  choices: scenario.previousPrompt.reply_markup.inline_keyboard.flat(),
};
const { promise: codexChoicePublished, resolve: recordCodexChoice } = Promise.withResolvers();
const { promise: openCodePublished, resolve: recordOpenCodePublish } = Promise.withResolvers();
const { promise: openCodeViewRead, resolve: recordOpenCodeViewRead } = Promise.withResolvers();
let openCodePosts = 0;
let openCodeStream;
let openCodeDisconnected;
let openCodeProbes = 0;
let openCodeSubscriptions = 0;
let openCodeSecondPublished;
let openCodeFormState = scenario.openCode?.initialFormState ?? { status: 'pending' };
let openCodeChoiceEdits = 0;
let failedOpenCodeFormList = false;
let openCodePermission;
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

function sendOpenCodeViewed(sessionID) {
  sendOpenCodeEvent({
    type: 'session.viewed', id: 'viewed', created: 100,
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, idle: 50 },
  });
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
      if (scenario.openCode.unavailableOnStartup && polls === 0) {
        return new Response(null, { status: 503 });
      }
      const pid = ++openCodeProbes >= 3 && scenario.openCode.replaceProcess ? 5678 : 1234;
      return Response.json({ pid, version: '2.3.2' });
    }
    if (target.pathname === '/api/event') {
      openCodeSubscriptions++;
      const signal = options?.signal ?? (url instanceof Request ? url.signal : undefined);
      openCodeDisconnected = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      const body = new ReadableStream({
        start(controller) {
          openCodeStream = controller;
          controller.enqueue(openCodeEncoder.encode('data: {"type":"server.connected","id":"connected","data":{}}\n\n'));
          if (text && (openCodeSubscriptions === 1 || !scenario.openCode.replaceRegistration)) sendOpenCodeText(sessionID, text);
          if (scenario.openCode.viewedOnStartup) sendOpenCodeViewed(sessionID);
          if (scenario.openCode.replaceRegistration && openCodeSubscriptions > 1 && !scenario.openCode.activeOnReconnect) {
            sendOpenCodeViewed(sessionID);
          }
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
        || (scenario.openCode.activeOnReconnect && openCodeSubscriptions > 1)
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
    if (target.pathname === `/api/session/${sessionID}/form`) {
      if (scenario.openCode.failFormListAfterReconnect && openCodeSubscriptions > 1 && !failedOpenCodeFormList) {
        failedOpenCodeFormList = true;
        return new Response(null, { status: 503 });
      }
      return Response.json({ data: form && openCodeFormState.status === 'pending' ? [form] : [] });
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
    const pendingPermission = openCodePermission ?? permission;
    if (target.pathname === permissionPath) {
      return Response.json({ data: pendingPermission ? [pendingPermission] : [] });
    }
    if (permission && method === 'GET' && target.pathname === `${permissionPath}/${permission.id}`) {
      const changed = scenario.openCode.changePermission;
      return Response.json({ data: changed ? { ...permission, resources: ['/fixture/different.txt'] } : pendingPermission });
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
      result = { message_id: (scenario.firstMessageId ?? 1) + sentCount++, chat: telegram.chat };
      if (scenario.codexChoice && !params.reply_parameters && params.text.startsWith('Codex ·')) recordCodexChoice();
      if (params.text.startsWith('OpenCode ·')) {
        openCodePosts++;
        recordOpenCodePublish();
        if (openCodePosts > 1) openCodeSecondPublished?.();
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
      const original = previousPrompt ?? ((scenario.recoverDuringPoll || scenario.openCode?.recoverStream) && prompts[0]);
      if (original && params.message_id === original.message.message_id
        && params.reply_markup.inline_keyboard.length && !recoveredPrompt) {
        recoveredPrompt = { message: original.message, choices: params.reply_markup.inline_keyboard.flat() };
      }
      result = true;
      break;
    case 'answerCallbackQuery':
      result = true;
      break;
    case 'getUpdates':
      if (scenario.holdPoll) {
        await new Promise((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener('abort', resolve, { once: true });
        });
        throw options.signal.reason;
      }
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
        if (scenario.openCode?.replaceRegistration) {
          // The previous SSE stays open while the local registry moves to another server instance.
          await writeFile(join(process.env.XDG_STATE_HOME, 'opencode', 'service.json'), JSON.stringify({
            id: 'replacement-fixture-instance', version: '2.3.2', url: 'http://127.0.0.1:32123', pid: 1234,
            password: 'fixture-not-a-secret',
          }));
        }
        result = scenario.updates || [];
      } else if (polls === 2 && (scenario.openCode?.viewAfterFirstPoll || scenario.codexLoadAfterFirstPoll)) {
        if (scenario.openCode?.viewAfterFirstPoll) {
          sendOpenCodeViewed(scenario.openCode.sessionID);
          await openCodeViewRead;
        }
        const previous = scenario.updates[0];
        result = [{ update_id: previous.update_id + 1, message: {
          ...previous.message, message_id: previous.message.message_id + 1, text: 'Ответ после открытия исходного диалога',
        } }];
      } else if (polls === 2 && scenario.openCode?.replacePermission) {
        const { sessionID, permission, replacePermission } = scenario.openCode;
        const { promise, resolve } = Promise.withResolvers();
        openCodeSecondPublished = resolve;
        sendOpenCodeEvent({
          type: 'permission.replied', id: 'permission-replied', created: 2,
          data: { sessionID, requestID: permission.id, reply: 'reject' },
        });
        openCodePermission = replacePermission;
        sendOpenCodeEvent({
          type: 'permission.asked', id: 'permission-replacement', created: 3, data: replacePermission,
        });
        await promise;
        result = [];
      } else if (polls === 2 && scenario.openCode?.resumedReply) {
        const { promise, resolve } = Promise.withResolvers();
        openCodeSecondPublished = resolve;
        sendOpenCodeText(scenario.openCode.sessionID, 'Новый ответ после возобновления');
        await promise;
        result = [scenario.openCode.resumedReply];
      } else if (polls === 2 && scenario.recoverDuringPoll) {
        if (scenario.recoverDuringPoll === 'truncated') {
          return new Response('{"ok":', { status: 200 });
        }
        return new Response(JSON.stringify({ ok: false, error_code: 503 }), { status: 503 });
      } else if (polls === 2 && scenario.openCode?.recoverStream) {
        openCodeStream.close();
        await openCodeDisconnected;
        result = [];
      } else if (scenario.restoredCallbacks
        && ((scenario.recoverDuringPoll || scenario.openCode?.recoverStream) ? [3, 4].includes(polls) : polls === 2)) {
        result = scenario.restoredCallbacks.flatMap(({ old, choice, newMessage, ...overrides }, index) => {
          if ((scenario.recoverDuringPoll || scenario.openCode?.recoverStream) && Boolean(old) !== (polls === 3)) return [];
          const prompt = old ? previousPrompt ?? prompts[0] : newMessage ? prompts[0] : recoveredPrompt;
          return [{ update_id: 100 + index, callback_query: {
            id: `recovery-${index}`, from: { id: 300, is_bot: false },
            message: prompt?.message, data: prompt?.choices[choice]?.callback_data, ...overrides,
          } }];
        });
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

function makeCallback({ prompt, choice, choiceLabel, tokenFrom = prompt, messageOverrides, ...overrides }, index) {
  const buttons = prompts[tokenFrom]?.choices;
  const button = choiceLabel ? buttons?.find(({ text }) => text.startsWith(choiceLabel)) : buttons?.[choice];
  return {
    update_id: 100 + index,
    callback_query: {
      id: `callback-${index}`,
      from: { id: 300, is_bot: false },
      message: { ...prompts[prompt]?.message, ...messageOverrides },
      data: button?.callback_data,
      ...overrides,
    },
  };
}

childProcess.spawn = (command, args, options) => {
  if (command !== 'codex') return spawn(command, args, options);
  assert.deepEqual(args, ['app-server', 'proxy']);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let transport;
  let socket;
  let failNextWrite = false;
  const proxy = Object.assign(new EventEmitter(), {
    stdin: new Transform({
      transform(chunk, encoding, callback) {
        if (!failNextWrite) {
          callback(null, chunk);
          return;
        }
        emit({ method: 'serverRequest/resolved', params: {
          threadId: scenario.codexChoice.params.threadId, requestId: scenario.codexChoice.id,
        } });
        callback(new Error('fixture write failure'));
      },
    }),
    stdout: new PassThrough(),
    kill() {
      socket?.terminate();
      transport?.destroy();
      server.close();
      this.stdout.end();
    },
  });
  server.on('listening', () => {
    if (scenario.codexHandshakeStalls) return;
    transport = connect({ host: '127.0.0.1', port: server.address().port });
    transport.on('error', (error) => proxy.emit('error', error));
    proxy.stdin.pipe(transport).pipe(proxy.stdout);
  });
  server.on('error', (error) => proxy.emit('error', error));
  const emit = (packet) => socket.send(JSON.stringify(packet));
  emitCodexPacket = emit;

  function onMessage(line) {
    const { method, id, params, result: clientResult } = JSON.parse(line);
    if (!method && clientResult && scenario.codexChoice) {
      record('codex', 'serverResponse', { id, result: clientResult });
      if (scenario.crashAfterResponse) {
        process.send({ channel: 'fixture', method: 'crash' }, () => process.exit(70));
      } else if (scenario.disconnectAfterPermissionWrite) {
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
        result = { codexHome: process.env.CODEX_HOME };
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
        if (scenario.failChoiceWrite && polls >= 2) failNextWrite = true;
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
        if (scenario.crashDuringSteer) {
          process.send({ channel: 'fixture', method: 'crash' }, () => process.exit(70));
          return;
        }
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
      if (scenario.codexReplayDelay) setTimeout(() => emit(scenario.codexChoice), scenario.codexReplayDelay);
      else emit(scenario.codexChoice);
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
  }
  server.on('connection', (connection) => {
    socket = connection;
    socket.on('error', (error) => proxy.emit('error', error));
    socket.on('message', onMessage);
  });
  return proxy;
};
syncBuiltinESMExports();
