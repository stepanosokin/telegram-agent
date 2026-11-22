import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

class AppServerRejection extends Error {
  constructor(code) {
    super('App Server Codex отклонил запрос.');
    this.beforeSubmission = [-32600, -32601, -32602].includes(code);
  }
}

export function openAppServer(onEvent, onDisconnect) {
  const proxy = spawn('codex', ['app-server', 'proxy'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  // The proxy carries raw bytes to the local control socket, including WebSocket framing.
  const transport = new Duplex({
    read() { proxy.stdout.resume(); },
    write(chunk, encoding, callback) { proxy.stdin.write(chunk, encoding, callback); },
  });
  const socket = new WebSocket('ws://localhost', {
    createConnection: () => transport,
    perMessageDeflate: false,
  });
  const handshakeTimer = setTimeout(close, 10_000);
  const { promise: ready, resolve: markReady } = Promise.withResolvers();
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const deliveryReceipts = new Map();
  const disconnected = new Error('Связь с общим App Server Codex потеряна.');

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    for (const request of pending.values()) request.reject(disconnected);
    pending.clear();
    markReady(false);
    socket.terminate();
    transport.destroy();
    proxy.kill();
    onDisconnect();
  }

  proxy.on('error', close);
  proxy.on('exit', close);
  proxy.stdin.on('error', close);
  proxy.stdout.on('error', close);
  proxy.stdout.on('end', close);
  proxy.stdout.on('data', (chunk) => {
    if (!transport.push(chunk)) proxy.stdout.pause();
  });
  socket.on('open', () => {
    clearTimeout(handshakeTimer);
    markReady(true);
  });
  socket.on('error', close);
  socket.on('close', close);
  socket.on('message', (data, binary) => {
    if (binary) {
      close();
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      close();
      return;
    }
    if (message?.id === undefined && typeof message?.method === 'string') {
      const { threadId, item } = message.params ?? {};
      if (message.method === 'item/completed' && item?.type === 'userMessage') {
        const receipt = deliveryReceipts.get(item.clientId);
        if (receipt && receipt.threadId === threadId) receipt.confirm('delivered');
      }
      onEvent(message.method, message.params);
      return;
    }
    if (['item/tool/requestUserInput', 'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(message?.method)
      && (typeof message.id === 'string' || Number.isSafeInteger(message.id))) {
      onEvent(message.method, message.params, message.id);
      return;
    }
    if (message?.method || !pending.has(message?.id)) return;
    const request = pending.get(message.id);
    if (message.error) request.reject(new AppServerRejection(message.error.code));
    else request.resolve(message.result);
  });

  function write(packet) {
    if (closed) throw disconnected;
    socket.send(JSON.stringify(packet), (error) => { if (error) close(); });
  }

  async function call(method, params) {
    const id = ++nextId;
    const timer = setTimeout(close, 10_000);
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }

  async function startIdleThread(threadId, input) {
    // A queue start checks idleness atomically. turn/start can steer a newer turn.
    const clientUserMessageId = randomUUID();
    const receipt = new Promise((confirm) => deliveryReceipts.set(clientUserMessageId, { threadId, confirm }));
    let queuedSubmissionId;
    try {
      try {
        const queued = await call('thread/queue/add', { threadId, input, clientUserMessageId });
        if (typeof queued?.queuedSubmission?.id === 'string' && queued.queuedSubmission.id) {
          queuedSubmissionId = queued.queuedSubmission.id;
          const started = await call('thread/queue/start', { threadId, queuedSubmissionId });
          if (typeof started?.turn?.id === 'string' && started.turn.id) return 'delivered';
        }
      } catch (error) {
        if (error instanceof AppServerRejection) {
          if (!queuedSubmissionId && error.beforeSubmission) return 'unavailable';
          if (queuedSubmissionId) {
            const removal = await call('thread/queue/delete', { threadId, queuedSubmissionId }).catch(() => null);
            if (removal?.deleted === true) return 'unavailable';
          }
        }
      }
      // The daemon may already have started this specific queued message.
      return await Promise.race([receipt, delay(1500, 'unknown')]);
    } finally {
      deliveryReceipts.delete(clientUserMessageId);
    }
  }

  async function activeTurnId(threadId) {
    const turns = await call('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    const [activeTurn] = Array.isArray(turns?.data) ? turns.data : [];
    if (activeTurn?.status === 'inProgress' && typeof activeTurn.id === 'string' && activeTurn.id) return activeTurn.id;
  }

  function respond(id, result) {
    return new Promise((resolve, reject) => {
      if (closed) throw disconnected;
      socket.send(JSON.stringify({ id, result }), (error) => {
        if (error) reject(disconnected);
        else resolve(undefined);
      });
    });
  }

  return {
    async initialize() {
      if (!await ready || closed) throw disconnected;
      await call('initialize', {
        clientInfo: { name: 'telegram-agent', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      write({ method: 'initialized' });
    },
    async isLoaded(threadId) {
      let cursor;
      const visited = new Set();
      do {
        const page = await call('thread/loaded/list', { cursor });
        if (!Array.isArray(page?.data)) return false;
        if (page.data.includes(threadId)) return true;
        cursor = page.nextCursor;
        if (visited.has(cursor)) return false;
        visited.add(cursor);
      } while (typeof cursor === 'string' && cursor !== '');
      return false;
    },
    async read(threadId) {
      const response = await call('thread/read', { threadId, includeTurns: false });
      return response?.thread;
    },
    async subscribe(threadId) {
      const response = await call('thread/resume', { threadId, excludeTurns: true });
      return response?.thread;
    },
    activeTurnId,
    respond,
    async respondPermission(id, decision, resolved) {
      // Closure alone does not identify which client answered the request.
      const deadline = new AbortController();
      try {
        const written = respond(id, { decision }).then(() => resolved);
        return await Promise.race([written, delay(1500, false, { signal: deadline.signal })])
          ? 'sent' : 'unknown';
      } finally {
        deadline.abort();
      }
    },
    async deliver(thread, text, submit) {
      const threadId = thread.id;
      const input = [{ type: 'text', text, text_elements: [] }];
      if (thread.status.type === 'active') {
        const expectedTurnId = await activeTurnId(threadId).catch(() => undefined);
        if (!expectedTurnId) return 'unavailable';
        return submit(async () => {
          try {
            const response = await call('turn/steer', { threadId, expectedTurnId, input });
            return response?.turnId === expectedTurnId ? 'delivered' : 'unknown';
          } catch (error) {
            return error instanceof AppServerRejection && error.beforeSubmission ? 'unavailable' : 'unknown';
          }
        });
      }
      return submit(() => startIdleThread(threadId, input));
    },
    close,
  };
}
