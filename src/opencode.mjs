import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

const isV2 = (version) => /^2\./.test(version);
const requestTimeout = 10_000;

async function localRegistration(file) {
  const entry = JSON.parse(await readFile(file, 'utf8'));
  const url = new URL(entry.url);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return;
  return { origin: url.origin, id: entry.id, pid: entry.pid };
}

export async function openOpenCode(onEvent, onDisconnect, stopSignal) {
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  const file = join(state, 'opencode', 'service.json');
  // Treat the owner-controlled OpenCode registry as trusted. The SDK probes its URL during discovery.
  const registration = await localRegistration(file);
  if (!registration) return;
  const endpoint = await Service.discover({ file, version: isV2 });
  if (!endpoint?.auth || new URL(endpoint.url).origin !== registration.origin) return;

  const client = OpenCode.make({
    baseUrl: registration.origin,
    headers: Service.headers(endpoint),
    fetch: (input, options) => fetch(input, { ...options, redirect: 'error' }),
  });
  const controller = new AbortController();
  const signal = AbortSignal.any([stopSignal, controller.signal]);
  const request = () => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]) });
  const server = await client.server.info(request());
  if (server.pid !== registration.pid || !isV2(server.version)) return;

  const { promise: ready, resolve: connected } = Promise.withResolvers();
  const stream = (async () => {
    try {
      for await (const event of client.event.subscribe({ signal })) {
        if (event.type === 'server.connected') connected(true);
        else onEvent(event);
      }
    } catch {
      // The unconfirmed sessions stay unavailable after the stream disconnects.
    } finally {
      controller.abort();
      connected(false);
      onDisconnect();
    }
  })();
  const timeout = setTimeout(() => controller.abort(), requestTimeout);
  const isConnected = await ready.finally(() => clearTimeout(timeout));
  if (!isConnected || signal.aborted) return;

  async function currentServer() {
    const registered = await localRegistration(file);
    if (registered?.id !== registration.id || registered?.pid !== registration.pid
      || registered?.origin !== registration.origin) return false;
    const current = await client.server.info(request());
    return !signal.aborted && current.pid === server.pid && current.version === server.version;
  }

  return {
    active() {
      return client.session.active(request());
    },
    read(sessionID) {
      return client.session.get({ sessionID }, request());
    },
    async pendingForms(sessionID) {
      if (await currentServer()) return client.session.form.list({ sessionID }, request());
    },
    async readForm(sessionID, formID) {
      if (await currentServer()) return client.session.form.get({ sessionID, formID }, request());
    },
    async replyForm(sessionID, formID, answer, canReply) {
      if (!(await currentServer().catch(() => false)) || !canReply()) return 'closed';
      try {
        await client.session.form.reply({ sessionID, formID, answer }, request());
        return 'accepted';
      } catch (error) {
        if (['FormAlreadySettledError', 'FormNotFoundError', 'SessionNotFoundError']
          .includes(error?.name)) return 'closed';
        return 'unknown';
      }
    },
    async pendingPermissions(sessionID) {
      if (await currentServer()) return client.permission.list({ sessionID }, request());
    },
    async readPermission(sessionID, requestID) {
      if (await currentServer()) return client.permission.get({ sessionID, requestID }, request());
    },
    async deliver(sessionID, text) {
      try {
        if (!await currentServer()) return 'unconfirmed';
        const active = await client.session.active(request());
        // Read persisted timing last. Prompt does not accept an atomic execution-owner precondition.
        const session = await client.session.get({ sessionID }, request());
        if (session?.id !== sessionID || !session.time || session.time.archived !== undefined) return 'unconfirmed';
        const { busy = 0, idle = 0 } = session.time;
        if (busy > idle && active[sessionID]?.type !== 'running') return 'unconfirmed';
      } catch {
        return 'unconfirmed';
      }
      if (signal.aborted) return 'unconfirmed';
      try {
        // Queue the reply in this session without steering a different active execution.
        const id = `msg_${randomUUID()}`;
        const receipt = await client.session.prompt({ sessionID, id, text, delivery: 'queue' }, request());
        return receipt?.id === id && receipt.sessionID === sessionID ? 'delivered' : 'unknown';
      } catch (error) {
        return ['InvalidRequestError', 'UnauthorizedError', 'SessionNotFoundError', 'LocationNotFoundError', 'ConflictError']
          .includes(error?.name) ? 'unavailable' : 'unknown';
      }
    },
    close() {
      controller.abort();
      return stream;
    },
  };
}
