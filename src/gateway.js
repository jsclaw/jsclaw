/**
 * Gateway — WebSocket control plane speaking openclaw's wire shape:
 *
 *   client → { type: 'req',   id, method, params }
 *   server → { type: 'res',   id, ok, payload | error }
 *   server → { type: 'event', event, payload }
 *
 * Auth: ?token= on the upgrade (webchat path), or openclaw's connect
 * handshake — tokenless sockets get a connect.challenge event and must
 * send {method:'connect', params:{auth:{password|token}}} within 10s.
 * Default bind 127.0.0.1 on openclaw's port 18789. Serves the embedded
 * webchat at /chat. Zero dependencies — the WebSocket layer is src/ws.js.
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
import { handleCommand, listCommands } from './commands.js';
import { loadSkills } from './skills.js';
import { createMcpHandler, toolJson, toolText, toolError, rpcError, RPC_ERRORS } from './mcp.js';
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
 * @property {(agentId: string, message: string, onOutput: (output: Object) => void) => Promise<Object>} runAgent
 *   Runs an agent for an agent; onOutput receives each streaming output.
 * @property {import('./task-store.js').TaskStore} [store] - Enables tasks.* methods
 * @property {() => Promise<void>} [triggerHeartbeat] - Enables heartbeat.trigger
 * @property {() => string[]} [getAgents] - Agent folders for status (defaults to agentsDir listing)
 * @property {import('./sessions.js').SessionStore} [sessions] - Enables session continuity + sessions.* methods
 * @property {import('./plugins.js').PluginRegistrations} [plugins] - Plugin-contributed gateway methods and MCP tools
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

  const getAgents = deps.getAgents || (() => {
    try {
      return readdirSync(config.agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  });

  // --- Method dispatch ---

  async function dispatch(method, params = {}, conn) {
    // openclaw handshake: sockets without a valid ?token= upgrade in a
    // pre-auth state and must authenticate with a connect frame
    // (auth.password or auth.token) before any other method.
    if (method === 'connect') {
      // openclaw clients send every credential they hold (stale stored
      // token alongside the typed password) — accept if ANY matches.
      const creds = Object.values(params?.auth || {}).filter((v) => typeof v === 'string');
      if (token && !creds.some((c) => tokenMatches(c, token))) {
        log.warn('Gateway connect rejected: bad credentials');
        setTimeout(() => conn.close?.(), 50);
        throw new Error('unauthorized');
      }
      conn.authed = true;
      clearTimeout(conn.preauthTimer);
      return {
        protocol: 4,
        auth: { role: params?.role || 'operator', scopes: [] },
        policy: { tickIntervalMs: 30000 },
      };
    }
    if (!conn.authed) throw new Error('unauthorized: send a connect frame first');

    switch (method) {
      case 'status': {
        const tasks = deps.store ? deps.store.listTasks() : [];
        return {
          version: VERSION,
          uptimeMs: Date.now() - startedAt,
          model: config.model ?? null,
          agents: getAgents(),
          tasks: {
            total: tasks.length,
            active: tasks.filter((t) => t.status === 'active').length,
          },
          clients: connections.size,
        };
      }

      case 'chat.send': {
        // openclaw clients address sessions; ours address agents — accept both
        const agentId = params.agentId || params.sessionKey;
        let { message } = params;
        if (!agentId || !message) throw new Error('chat.send requires agentId (or sessionKey) and message');
        const sessionKey = params.sessionKey || agentId;
        const runId = params.runId || randomUUID().slice(0, 8);

        // Slash commands are host-handled
        const command = await handleCommand(message, {
          config, agentId, version: VERSION,
          reset: () => { deps.sessions?.reset(sessionKey); },
        }).catch(() => null);
        if (command?.reply) {
          const output = { status: 'success', result: command.reply };
          conn.sendFrame({ type: 'event', event: 'agent.output', payload: { runId, agentId, ...output } });
          conn.sendFrame({ type: 'event', event: 'chat', payload: {
            sessionKey, runId, state: 'final',
            message: { role: 'assistant', content: [{ type: 'text', text: command.reply }] },
          } });
          return { runId, ...output };
        }
        if (command?.prompt) message = command.prompt;

        const session = deps.sessions?.resolve(sessionKey, agentId);
        const priorMessages = deps.sessions?.loadMessages(sessionKey) ?? [];
        // Resolve on the first terminal output: every ContainerOutput is a
        // completed turn, but the runner process lingers for follow-up IPC
        // (up to the idle timeout) and runAgent only settles when it exits.
        let settleFirst;
        const firstOutput = new Promise((r) => { settleFirst = r; });
        const run = deps.runAgent(agentId, message, (output) => {
          // Host-owned transcripts (agent-micro) vs SDK-owned id (Claude Code)
          if (output.messages) deps.sessions?.saveMessages(sessionKey, output.messages, agentId);
          if (output.newSessionId) deps.sessions?.advance(sessionKey, output.newSessionId);
          settleFirst(output);
          conn.sendFrame({ type: 'event', event: 'agent.output', payload: { runId, agentId, ...output } });
          // openclaw chat event shape (consumed by openclaw tui & friends)
          conn.sendFrame({ type: 'event', event: 'chat', payload: {
            sessionKey,
            runId,
            state: output.status === 'error' ? 'error' : 'final',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: output.result ?? output.error ?? '' }],
            },
          } });
        }, {
          ...(priorMessages.length && { messages: priorMessages }),
          ...(session?.sessionId && { sessionId: session.sessionId }),
          ...(session?.model && { model: session.model }),
        });
        run.then((result) => settleFirst(result)).catch((err) => settleFirst({ status: 'error', result: null, error: err.message }));
        const result = await firstOutput;
        return { runId, ...result };
      }

      case 'chat.history': {
        const key = params.sessionKey || params.agentId || 'main';
        const limit = Number(params.limit) > 0 ? Number(params.limit) : 50;
        const messages = (deps.sessions?.loadMessages(key) ?? []).slice(-limit);
        return { items: messages, messages, hasMore: false };
      }

      case 'chat.abort':
        return { aborted: false }; // no per-run abort yet (#45)
      case 'agents.list':
        return { agents: getAgents().map((id) => ({ id, name: id })), defaultId: 'main' };
      case 'models.list':
        return { models: config.model ? [{ id: config.model, name: config.model }] : [] };
      case 'sessions.list':
        return deps.sessions ? deps.sessions.list({ agentId: params.agentId }) : { sessions: [] };
      case 'sessions.reset': {
        if (!deps.sessions) throw new Error('sessions are not wired on this gateway');
        return deps.sessions.reset(requireParam(params, 'key'), params.reason === 'new' ? 'new' : 'reset');
      }
      case 'sessions.patch': {
        if (!deps.sessions) throw new Error('sessions are not wired on this gateway');
        return { ok: true, session: deps.sessions.patch(requireParam(params, 'key'), params) };
      }
      case 'commands.list':
        return { commands: listCommands(config) };

      case 'tasks.list': {
        requireStore();
        return deps.store.listTasks(params.agentId);
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
        return listMemoryFiles(requireParam(params, 'agentId'), config)
          .map(({ name, size }) => ({ name, size }));
      case 'memory.search':
        return searchMemory(
          requireParam(params, 'agentId'),
          requireParam(params, 'query'),
          config
        );

      default: {
        const pluginMethod = deps.plugins?.gatewayMethods?.[method];
        if (pluginMethod) return pluginMethod(params, { config });
        throw new Error(`unknown method: ${method}`);
      }
    }

    function requireStore() {
      if (!deps.store) throw new Error('tasks are not wired on this gateway');
    }
    function requireParam(p, name) {
      if (!p[name]) throw new Error(`${method} requires ${name}`);
      return p[name];
    }
  }

  // --- MCP server (#73): openclaw's bridge vocabulary over JSS's
  // stateless Streamable HTTP transport. Pure delegation to dispatch.
  const mcpConn = { authed: true, sendFrame: () => {}, close: () => {} };
  // Plugin MCP tools: handlers may return strings (wrapped as text) or
  // full MCP content objects.
  const pluginMcpTools = Object.fromEntries(
    Object.entries(deps.plugins?.mcpTools || {}).map(([name, t]) => [name, {
      description: t.description || name,
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      handler: async (args) => {
        const out = await t.handler(args, { config });
        return typeof out === 'string' ? toolText(out) : out;
      },
    }])
  );

  const mcpHandler = createMcpHandler({
    serverInfo: { name: 'jsclaw', version: VERSION },
    tools: {
      ...pluginMcpTools,
      conversations_list: {
        description: 'List conversations (sessions). Each row has key, agentId, sessionId, label, model, updatedAt.',
        inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } } },
        handler: async (args) => toolJson(await dispatch('sessions.list', { agentId: args.agent_id }, mcpConn)),
      },
      messages_send: {
        description: 'Send a message into a conversation and return the agent reply. session_key names the conversation; agent_id (default main) is used for new conversations.',
        inputSchema: {
          type: 'object',
          properties: {
            session_key: { type: 'string' },
            message: { type: 'string' },
            agent_id: { type: 'string' },
          },
          required: ['session_key', 'message'],
        },
        handler: async (args) => {
          const result = await dispatch('chat.send', {
            sessionKey: args.session_key,
            ...(args.agent_id && { agentId: args.agent_id }),
            message: args.message,
          }, mcpConn);
          if (result.status === 'error') return toolError(result.error || 'agent error');
          return toolText(result.result ?? '');
        },
      },
      messages_read: {
        description: 'Read recent messages from a conversation (most recent transcript).',
        inputSchema: {
          type: 'object',
          properties: { session_key: { type: 'string' }, limit: { type: 'number' } },
          required: ['session_key'],
        },
        handler: async (args) => toolJson(await dispatch('chat.history', { sessionKey: args.session_key, limit: args.limit }, mcpConn)),
      },
      agents_list: {
        description: 'List agents on this gateway.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => toolJson(await dispatch('agents.list', {}, mcpConn)),
      },
      skills_list: {
        description: 'List installed skills (name, description, how they surface).',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => toolJson(loadSkills(config).map(({ name, description, trigger, userInvocable }) => ({
          name, description, surfacing: trigger ? `trigger:${trigger}` : 'description-driven', userInvocable: Boolean(userInvocable),
        }))),
      },
    },
  });

  function mcpAuthorized(req, url) {
    if (!token) return true;
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    return tokenMatches(bearer, token) || tokenMatches(url.searchParams.get('token'), token);
  }

  // --- HTTP server (webchat + upgrade) ---

  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (path === '/mcp' && req.method === 'POST') {
      const url = new URL(req.url, 'http://localhost');
      if (!mcpAuthorized(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rpcError(null, RPC_ERRORS.INVALID_REQUEST, 'unauthorized: Bearer token required')));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy();
      });
      req.on('end', async () => {
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rpcError(null, RPC_ERRORS.PARSE_ERROR, 'invalid JSON')));
          return;
        }
        try {
          const response = await mcpHandler(msg);
          if (response === null) {
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rpcError(msg?.id ?? null, RPC_ERRORS.INTERNAL_ERROR, err.message)));
        }
      });
      return;
    }
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

    // A correct ?token= authenticates at upgrade (webchat path). A wrong
    // one is rejected. No token at all upgrades into a pre-auth state for
    // the openclaw connect handshake.
    const queryToken = url.searchParams.get('token');
    if (token && queryToken !== null && !tokenMatches(queryToken, token)) {
      log.warn('Gateway upgrade rejected: bad token');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const preAuthed = !token || (queryToken !== null && tokenMatches(queryToken, token));

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

    const conn = { authed: preAuthed };
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
      onClose: () => {
        clearTimeout(conn.preauthTimer);
        clearInterval(conn.tickTimer);
        connections.delete(conn);
      },
    }, head);

    conn.sendFrame = (obj) => ws.send(JSON.stringify(obj));
    conn.close = ws.close;
    connections.add(conn);

    conn.sendFrame({ type: 'event', event: 'hello', payload: { version: VERSION } });
    if (!conn.authed) {
      // openclaw connect handshake: challenge now, expect a connect frame
      conn.sendFrame({ type: 'event', event: 'connect.challenge', payload: { nonce: randomUUID() } });
      conn.preauthTimer = setTimeout(() => { if (!conn.authed) conn.close(); }, 10000);
    }
    // openclaw clients treat a silent gateway as dead (policy.tickIntervalMs)
    conn.tickTimer = setInterval(() => conn.sendFrame({ type: 'event', event: 'tick', payload: {} }), 15000);
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
