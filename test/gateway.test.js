import { test } from 'node:test';
import assert from 'node:assert';
import { startGateway } from '../src/gateway.js';
import { TaskStore } from '../src/task-store.js';
import { tempConfig } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Promise-based test client over Node's native WebSocket. */
function connect(port, token) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/${token ? `?token=${token}` : ''}`;
    const ws = new WebSocket(url);
    const events = [];
    const pending = new Map();
    let nextId = 1;

    ws.onmessage = (e) => {
      const frame = JSON.parse(e.data);
      if (frame.type === 'event') {
        events.push(frame);
      } else if (frame.type === 'res' && pending.has(frame.id)) {
        pending.get(frame.id)(frame);
        pending.delete(frame.id);
      }
    };
    ws.onopen = () => resolve({
      ws,
      events,
      req(method, params) {
        return new Promise((res) => {
          const id = nextId++;
          pending.set(id, res);
          ws.send(JSON.stringify({ type: 'req', id, method, params }));
        });
      },
      close: () => ws.close(),
    });
    ws.onerror = () => reject(new Error('connection failed'));
  });
}

function fakeRunAgent(outputs = [{ status: 'success', result: 'final answer' }]) {
  return async (agentId, message, onOutput) => {
    for (const output of outputs) {
      if (onOutput) onOutput(output);
      await sleep(5);
    }
    return outputs[outputs.length - 1];
  };
}

async function startTestGateway(deps = {}, options = {}) {
  const config = tempConfig();
  const gateway = await startGateway(
    { runAgent: fakeRunAgent(), ...deps },
    config,
    { port: 0, ...options },
  );
  return { gateway, config };
}

test('handshake, hello event, and status round-trip', async () => {
  const { gateway } = await startTestGateway();
  const client = await connect(gateway.port);
  try {
    const res = await client.req('status');
    assert.equal(res.ok, true);
    assert.ok(res.payload.version);
    assert.ok(res.payload.uptimeMs >= 0);
    assert.equal(res.payload.clients, 1);

    await sleep(10);
    assert.ok(client.events.some((e) => e.event === 'hello'), 'hello event received');
  } finally {
    client.close();
    await gateway.stop();
  }
});

test('token auth: wrong token rejected, right token accepted, no token pre-auths', async () => {
  const { gateway } = await startTestGateway({}, { token: 'secret-token' });
  try {
    await assert.rejects(connect(gateway.port, 'wrong'), /connection failed/);
    // No token upgrades into the pre-auth state (openclaw handshake, #45):
    // the socket opens but methods are refused until a connect frame.
    const preauth = await connect(gateway.port);
    const denied = await preauth.req('status');
    assert.equal(denied.ok, false);
    preauth.close();
    const client = await connect(gateway.port, 'secret-token');
    const res = await client.req('status');
    assert.equal(res.ok, true);
    client.close();
  } finally {
    await gateway.stop();
  }
});

test('chat.send streams agent.output events then resolves', async () => {
  const { gateway } = await startTestGateway({
    runAgent: fakeRunAgent([
      { status: 'success', result: 'thinking out loud' },
      { status: 'success', result: 'final answer', newSessionId: 's1' },
    ]),
  });
  const client = await connect(gateway.port);
  try {
    const res = await client.req('chat.send', { agentId: 'main', message: 'hi' });
    assert.equal(res.ok, true);
    assert.equal(res.payload.result, 'final answer');
    assert.ok(res.payload.runId);

    const outputs = client.events.filter((e) => e.event === 'agent.output');
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0].payload.result, 'thinking out loud');
    assert.equal(outputs[0].payload.runId, res.payload.runId);
    assert.equal(outputs[0].payload.agentId, 'main');
  } finally {
    client.close();
    await gateway.stop();
  }
});

test('chat.send validates params', async () => {
  const { gateway } = await startTestGateway();
  const client = await connect(gateway.port);
  try {
    const res = await client.req('chat.send', { agentId: 'main' });
    assert.equal(res.ok, false);
    assert.match(res.error.message, /requires/);
  } finally {
    client.close();
    await gateway.stop();
  }
});

test('tasks methods drive a real TaskStore', async () => {
  const config = tempConfig();
  const store = new TaskStore(config);
  const task = store.createTask({
    agentId: 'g', chatJid: 'c', prompt: 'p',
    scheduleType: 'interval', scheduleValue: '60000',
  });

  const gateway = await startGateway({ runAgent: fakeRunAgent(), store }, config, { port: 0 });
  const client = await connect(gateway.port);
  try {
    let res = await client.req('tasks.list');
    assert.equal(res.payload.length, 1);

    res = await client.req('tasks.pause', { id: task.id });
    assert.equal(res.payload.status, 'paused');
    assert.equal(store.getTask(task.id).status, 'paused');

    res = await client.req('tasks.resume', { id: task.id });
    assert.equal(res.payload.status, 'active');

    res = await client.req('tasks.cancel', { id: task.id });
    assert.equal(res.ok, true);
    assert.equal(store.getTask(task.id), undefined);

    res = await client.req('tasks.cancel', { id: 'nope' });
    assert.equal(res.ok, false);
  } finally {
    client.close();
    await gateway.stop();
  }
});

test('tasks methods report cleanly when no store is wired', async () => {
  const { gateway } = await startTestGateway();
  const client = await connect(gateway.port);
  try {
    const res = await client.req('tasks.list');
    assert.equal(res.ok, false);
    assert.match(res.error.message, /not wired/);
  } finally {
    client.close();
    await gateway.stop();
  }
});

test('unknown methods and malformed frames get error responses', async () => {
  const { gateway } = await startTestGateway();
  const client = await connect(gateway.port);
  try {
    const res = await client.req('no.such.method');
    assert.equal(res.ok, false);
    assert.match(res.error.message, /unknown method/);

    client.ws.send('not json at all');
    client.ws.send(JSON.stringify({ type: 'weird' }));
    await sleep(20);
    // Connection survives garbage
    const ok = await client.req('status');
    assert.equal(ok.ok, true);
  } finally {
    client.close();
    await gateway.stop();
  }
});

test('large payloads exercise extended frame lengths both ways', async () => {
  const big = 'x'.repeat(120_000); // > 65535 → 64-bit length path
  const { gateway } = await startTestGateway({
    runAgent: async (g, message) => ({ status: 'success', result: message }),
  });
  const client = await connect(gateway.port);
  try {
    const res = await client.req('chat.send', { agentId: 'main', message: big });
    assert.equal(res.ok, true);
    assert.equal(res.payload.result.length, big.length);
  } finally {
    client.close();
    await gateway.stop();
  }
});

test('broadcast reaches every connected client', async () => {
  const { gateway } = await startTestGateway();
  const a = await connect(gateway.port);
  const b = await connect(gateway.port);
  try {
    gateway.broadcast('heartbeat.alert', { agentId: 'main', result: 'alert!' });
    await sleep(20);
    for (const client of [a, b]) {
      const hit = client.events.find((e) => e.event === 'heartbeat.alert');
      assert.ok(hit, 'client received the broadcast');
      assert.equal(hit.payload.result, 'alert!');
    }
    assert.equal(gateway.clients(), 2);
  } finally {
    a.close();
    b.close();
    await gateway.stop();
  }
});

test('webchat and health are served over HTTP', async () => {
  const { gateway } = await startTestGateway();
  try {
    const chat = await fetch(`http://127.0.0.1:${gateway.port}/chat`);
    assert.equal(chat.status, 200);
    const html = await chat.text();
    assert.ok(html.includes('jsclaw'));
    assert.ok(html.includes('chat.send'));

    const health = await fetch(`http://127.0.0.1:${gateway.port}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);

    const missing = await fetch(`http://127.0.0.1:${gateway.port}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await gateway.stop();
  }
});

test('memory methods work end to end', async () => {
  const config = tempConfig();
  const { appendMemory } = await import('../src/memory.js');
  appendMemory('main', 'preferences', 'prefers cream backgrounds', config);

  const gateway = await startGateway({ runAgent: fakeRunAgent() }, config, { port: 0 });
  const client = await connect(gateway.port);
  try {
    let res = await client.req('memory.list', { agentId: 'main' });
    assert.equal(res.payload.length, 1);
    assert.equal(res.payload[0].name, 'preferences.md');

    res = await client.req('memory.search', { agentId: 'main', query: 'cream' });
    assert.equal(res.payload.length, 1);
    assert.match(res.payload[0].text, /cream backgrounds/);
  } finally {
    client.close();
    await gateway.stop();
  }
});

// --- openclaw connect handshake (#45) ---

test('tokenless socket gets a challenge and authenticates via connect frame', async () => {
  const { gateway } = await startTestGateway({}, { token: 'secret' });
  const client = await connect(gateway.port); // no ?token=

  await sleep(30);
  const challenge = client.events.find((e) => e.event === 'connect.challenge');
  assert.ok(challenge, 'expected a connect.challenge event');
  assert.ok(challenge.payload.nonce.length > 0);

  // Pre-auth methods are refused
  const denied = await client.req('status', {});
  assert.equal(denied.ok, false);
  assert.match(denied.error.message, /connect/);

  // connect with the password (openclaw style)
  const hello = await client.req('connect', {
    minProtocol: 4, maxProtocol: 4,
    client: { id: 'test-client', mode: 'ui' },
    auth: { password: 'secret' },
    role: 'operator',
  });
  assert.equal(hello.ok, true);
  assert.equal(hello.payload.protocol, 4);
  assert.equal(typeof hello.payload.policy.tickIntervalMs, 'number');

  // Now methods work
  const status = await client.req('status', {});
  assert.equal(status.ok, true);

  client.close();
  await gateway.stop();
});

test('connect with bad credentials is refused', async () => {
  const { gateway } = await startTestGateway({}, { token: 'secret' });
  const client = await connect(gateway.port);
  const res = await client.req('connect', { auth: { password: 'wrong' } });
  assert.equal(res.ok, false);
  client.close();
  await gateway.stop();
});

test('query-token sockets are authed at upgrade and still get ticks', async () => {
  const { gateway } = await startTestGateway({}, { token: 'secret' });
  const client = await connect(gateway.port, 'secret');
  const status = await client.req('status', {});
  assert.equal(status.ok, true);
  assert.ok(!client.events.find((e) => e.event === 'connect.challenge'));
  client.close();
  await gateway.stop();
});

test('chat.send accepts sessionKey and emits openclaw chat events', async () => {
  const { gateway } = await startTestGateway({}, { token: 'secret' });
  const client = await connect(gateway.port, 'secret');

  const res = await client.req('chat.send', { sessionKey: 'main', message: 'hi', runId: 'run-1' });
  assert.equal(res.ok, true);
  assert.equal(res.payload.runId, 'run-1');

  const chatEvt = client.events.find((e) => e.event === 'chat');
  assert.ok(chatEvt, 'expected an openclaw chat event');
  assert.equal(chatEvt.payload.sessionKey, 'main');
  assert.equal(chatEvt.payload.state, 'final');
  assert.equal(chatEvt.payload.message.content[0].text, 'final answer');
  // legacy event still present for the webchat
  assert.ok(client.events.find((e) => e.event === 'agent.output'));

  client.close();
  await gateway.stop();
});

test('openclaw list methods respond with usable shapes', async () => {
  const { gateway, config } = await startTestGateway({}, { token: 'secret' });
  const client = await connect(gateway.port, 'secret');

  const agents = await client.req('agents.list', {});
  assert.equal(agents.ok, true);
  assert.ok(Array.isArray(agents.payload.agents));

  const models = await client.req('models.list', {});
  assert.equal(models.ok, true);
  assert.ok(Array.isArray(models.payload.models));

  const history = await client.req('chat.history', { sessionKey: 'main', limit: 10 });
  assert.equal(history.ok, true);
  assert.deepEqual(history.payload.messages, []);

  for (const m of ['sessions.list', 'commands.list', 'chat.abort']) {
    const r = await client.req(m, {});
    assert.equal(r.ok, true, `${m} should respond ok`);
  }

  client.close();
  await gateway.stop();
});

// --- sessions (#57) ---

test('chat.send threads session continuity and honors per-session model', async () => {
  const { SessionStore } = await import('../src/sessions.js');
  const config = tempConfig();
  const sessions = new SessionStore(config);
  const calls = [];
  const gateway = await startGateway({
    runAgent: async (agentId, message, onOutput, extra = {}) => {
      calls.push(extra);
      const output = { status: 'success', result: 'ok', newSessionId: `s-${calls.length}` };
      if (onOutput) await onOutput(output);
      return output;
    },
    sessions,
  }, config, { port: 0 });
  const client = await connect(gateway.port);

  await client.req('chat.send', { agentId: 'main', message: 'one' });
  await client.req('chat.send', { agentId: 'main', message: 'two' });
  assert.equal(calls[0].sessionId, undefined, 'first message starts fresh');
  assert.equal(calls[1].sessionId, 's-1', 'second message continues the transcript');

  // per-session model override flows into the run
  await client.req('sessions.patch', { key: 'main', model: 'glm-4.5-air' });
  await client.req('chat.send', { agentId: 'main', message: 'three' });
  assert.equal(calls[2].model, 'glm-4.5-air');

  // /reset drops continuity for real now
  await client.req('chat.send', { agentId: 'main', message: '/reset' });
  await client.req('chat.send', { agentId: 'main', message: 'four' });
  assert.equal(calls[3].sessionId, undefined, 'post-reset message starts fresh');

  const list = await client.req('sessions.list', {});
  assert.equal(list.payload.sessions[0].key, 'main');

  const reset = await client.req('sessions.reset', { key: 'main', reason: 'new' });
  assert.deepEqual(reset.payload, { ok: true, key: 'main', reason: 'new' });

  client.close();
  await gateway.stop();
});
