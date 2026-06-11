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

test('token auth: wrong token rejected, right token accepted', async () => {
  const { gateway } = await startTestGateway({}, { token: 'secret-token' });
  try {
    await assert.rejects(connect(gateway.port, 'wrong'), /connection failed/);
    await assert.rejects(connect(gateway.port), /connection failed/);
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
