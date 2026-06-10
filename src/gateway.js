/**
 * Gateway — WebSocket control plane speaking openclaw's wire shape:
 *
 *   client → { type: 'req',   id, method, params }
 *   server → { type: 'res',   id, ok, payload | error }
 *   server → { type: 'event', event, payload }
 *
 * Token auth on the upgrade (?token=...), default bind 127.0.0.1 on
 * openclaw's port 18789. Serves the embedded webchat at /chat.
 * Zero dependencies — the WebSocket layer is src/ws.js.
 * @module gateway
 */

import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptKey, attachWebSocket } from './ws.js';
import { createConfig } from './config.js';
import { listMemoryFiles, searchMemory } from './memory.js';
import { computeNextRun } from './task-store.js';

const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8')
).version;

const WEBCHAT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'webchat.html');

function tokenMatches(provided, expected) {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @typedef {Object} GatewayDeps
 * @property {(groupFolder: string, message: string, onOutput: (output: Object) => void) => Promise<Object>} runAgent
 *   Runs an agent for a group; onOutput receives each streaming output.
 * @property {import('./task-store.js').TaskStore} [store] - Enables tasks.* methods
 * @property {() => Promise<void>} [triggerHeartbeat] - Enables heartbeat.trigger
 * @property {() => string[]} [getGroups] - Group folders for status (defaults to groupsDir listing)
 */

/**
 * Start the gateway.
 *
 * @param {GatewayDeps} deps
 * @param {import('./types.js').JsclawConfig} [config]
 * @param {{ port?: number, host?: string, token?: string }} [options]
 * @returns {Promise<{ port: number, clients: () => number, broadcast: (event: string, payload?: Object) => void, stop: () => Promise<void> }>}
 */
export function startGateway(deps, config, options = {}) {
  config = config || createConfig();
  const log = config.logger;
  const {
    port = 18789,
    host = '127.0.0.1',
    token,
  } = options;

  if (typeof deps?.runAgent !== 'function') {
    throw new Error('startGateway requires a runAgent dependency');
  }

  const startedAt = Date.now();
  const connections = new Set();

  const getGroups = deps.getGroups || (() => {
    try {
      return readdirSync(config.groupsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  });

  // --- Method dispatch ---

  async function dispatch(method, params = {}, conn) {
    switch (method) {
      case 'status': {
        const tasks = deps.store ? deps.store.listTasks() : [];
        return {
          version: VERSION,
          uptimeMs: Date.now() - startedAt,
          groups: getGroups(),
          tasks: {
            total: tasks.length,
            active: tasks.filter((t) => t.status === 'active').length,
          },
          clients: connections.size,
        };
      }

      case 'chat.send': {
        const { groupFolder, message } = params;
        if (!groupFolder || !message) throw new Error('chat.send requires groupFolder and message');
        const runId = randomUUID().slice(0, 8);
        const result = await deps.runAgent(groupFolder, message, (output) => {
          conn.sendFrame({ type: 'event', event: 'agent.output', payload: { runId, groupFolder, ...output } });
        });
        return { runId, ...result };
      }

      case 'tasks.list': {
        requireStore();
        return deps.store.listTasks(params.groupFolder);
      }
      case 'tasks.pause':
      case 'tasks.resume': {
        requireStore();
        const task = deps.store.getTask(params.id);
        if (!task) throw new Error(`task not found: ${params.id}`);
        const status = method === 'tasks.pause' ? 'paused' : 'active';
        const fields = { status };
        if (status === 'active') fields.nextRun = computeNextRun(task);
        return deps.store.updateTask(task.id, fields);
      }
      case 'tasks.cancel': {
        requireStore();
        if (!deps.store.deleteTask(params.id)) throw new Error(`task not found: ${params.id}`);
        return { cancelled: params.id };
      }

      case 'heartbeat.trigger': {
        if (!deps.triggerHeartbeat) throw new Error('heartbeat is not wired on this gateway');
        await deps.triggerHeartbeat();
        return { triggered: true };
      }

      case 'memory.list':
        return listMemoryFiles(requireParam(params, 'groupFolder'), config)
          .map(({ name, size }) => ({ name, size }));
      case 'memory.search':
        return searchMemory(
          requireParam(params, 'groupFolder'),
          requireParam(params, 'query'),
          config
        );

      default:
        throw new Error(`unknown method: ${method}`);
    }

    function requireStore() {
      if (!deps.store) throw new Error('tasks are not wired on this gateway');
    }
    function requireParam(p, name) {
      if (!p[name]) throw new Error(`${method} requires ${name}`);
      return p[name];
    }
  }

  // --- HTTP server (webchat + upgrade) ---

  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (path === '/' || path === '/chat') {
      if (existsSync(WEBCHAT_PATH)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(WEBCHAT_PATH));
      } else {
        res.writeHead(500);
        res.end('webchat.html missing');
      }
      return;
    }
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: VERSION, uptimeMs: Date.now() - startedAt }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');

    if (token && !tokenMatches(url.searchParams.get('token'), token)) {
      log.warn('Gateway upgrade rejected: bad token');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );

    const conn = {};
    const ws = attachWebSocket(socket, {
      onMessage: async (text) => {
        let frame;
        try {
          frame = JSON.parse(text);
        } catch {
          conn.sendFrame({ type: 'res', id: null, ok: false, error: { message: 'invalid JSON frame' } });
          return;
        }
        if (frame.type !== 'req' || !frame.method) {
          conn.sendFrame({ type: 'res', id: frame.id ?? null, ok: false, error: { message: 'expected a req frame with a method' } });
          return;
        }
        try {
          const payload = await dispatch(frame.method, frame.params, conn);
          conn.sendFrame({ type: 'res', id: frame.id, ok: true, payload });
        } catch (err) {
          conn.sendFrame({ type: 'res', id: frame.id, ok: false, error: { message: err.message } });
        }
      },
      onClose: () => connections.delete(conn),
    }, head);

    conn.sendFrame = (obj) => ws.send(JSON.stringify(obj));
    conn.close = ws.close;
    connections.add(conn);

    conn.sendFrame({ type: 'event', event: 'hello', payload: { version: VERSION } });
  });

  function broadcast(event, payload = {}) {
    for (const conn of connections) {
      conn.sendFrame({ type: 'event', event, payload });
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      log.info(`Gateway listening on ${host}:${actualPort}`);
      resolve({
        port: actualPort,
        clients: () => connections.size,
        broadcast,
        stop: () => new Promise((r) => {
          for (const conn of connections) conn.close();
          server.close(r);
        }),
      });
    });
  });
}
