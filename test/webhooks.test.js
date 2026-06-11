import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { startWebhookIngress, renderTemplate, createWebhookEmitter } from '../src/webhooks.js';
import { tempConfig } from './helpers.js';

test('renderTemplate substitutes body paths', () => {
  assert.equal(renderTemplate('{{body.service}} is {{body.status}}', { service: 'api', status: 'up' }), 'api is up');
  assert.equal(renderTemplate('nested: {{body.a.b.c}}', { a: { b: { c: 'deep' } } }), 'nested: deep');
  assert.equal(renderTemplate('missing: [{{body.nope.x}}]', {}), 'missing: []');
  assert.equal(renderTemplate('whole: {{body}}', { x: 1 }), 'whole: {"x":1}');
  assert.equal(renderTemplate('raw: {{body}}', 'plain text'), 'raw: plain text');
  assert.equal(renderTemplate('spaced: {{ body.x }}', { x: 'ok' }), 'spaced: ok');
});

test('ingress: auth, routing, and template rendering', async () => {
  const config = tempConfig();
  const received = [];

  const { stop } = await startWebhookIngress({
    port: 19876,
    secret: 's3cret',
    endpoints: [{ path: '/deploy', message: 'Deploy: {{body.service}}', groupFolder: 'main' }],
    onMessage: async (message, endpoint) => received.push({ message, group: endpoint.groupFolder }),
  }, config);

  const post = (path, body, headers = {}) =>
    fetch(`http://127.0.0.1:19876${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  try {
    assert.equal((await post('/webhook/deploy', { service: 'api' }, { 'X-Webhook-Secret': 's3cret' })).status, 200);
    assert.deepEqual(received, [{ message: 'Deploy: api', group: 'main' }]);

    assert.equal((await post('/webhook/deploy', {}, { 'X-Webhook-Secret': 'wrong' })).status, 401);
    assert.equal((await post('/webhook/deploy', {})).status, 401);
    assert.equal((await post('/webhook/unknown', {}, { 'X-Webhook-Secret': 's3cret' })).status, 404);
    assert.equal((await fetch('http://127.0.0.1:19876/webhook/deploy')).status, 404); // GET

    assert.equal(received.length, 1);
  } finally {
    await stop();
  }
});

test('ingress: handler errors return 500', async () => {
  const config = tempConfig();
  const { stop } = await startWebhookIngress({
    port: 19877,
    endpoints: [{ path: '/x', message: 'm' }],
    onMessage: async () => { throw new Error('boom'); },
  }, config);

  try {
    const res = await fetch('http://127.0.0.1:19877/webhook/x', { method: 'POST', body: '{}' });
    assert.equal(res.status, 500);
  } finally {
    await stop();
  }
});

test('egress: event matching, filters, env header expansion', async () => {
  const deliveries = [];
  const sink = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      deliveries.push({ url: req.url, auth: req.headers['authorization'], body: JSON.parse(body) });
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((r) => sink.listen(19878, '127.0.0.1', r));

  process.env.TEST_HOOK_TOKEN = 'tok123';
  const emit = createWebhookEmitter([
    {
      event: 'agent.task.completed',
      url: 'http://127.0.0.1:19878/done',
      headers: { Authorization: 'Bearer ${TEST_HOOK_TOKEN}' },
    },
    {
      event: 'agent.error',
      url: 'http://127.0.0.1:19878/errors',
      filter: { groupFolder: 'prod' },
    },
    { event: '*', url: 'http://127.0.0.1:19878/all' },
  ], tempConfig());

  try {
    // Matching event + wildcard
    let count = await emit('agent.task.completed', { taskId: 't1' });
    assert.equal(count, 2);

    // Filter mismatch: only the wildcard fires
    count = await emit('agent.error', { groupFolder: 'dev' });
    assert.equal(count, 1);

    // Filter match
    count = await emit('agent.error', { groupFolder: 'prod' });
    assert.equal(count, 2);

    const done = deliveries.find((d) => d.url === '/done');
    assert.equal(done.auth, 'Bearer tok123');
    assert.equal(done.body.event, 'agent.task.completed');
    assert.equal(done.body.payload.taskId, 't1');
    assert.ok(done.body.timestamp);
  } finally {
    delete process.env.TEST_HOOK_TOKEN;
    await new Promise((r) => sink.close(r));
  }
});

test('egress: unreachable URLs do not throw', async () => {
  const emit = createWebhookEmitter(
    [{ event: 'e', url: 'http://127.0.0.1:1/nope' }],
    tempConfig()
  );
  const count = await emit('e', {});
  assert.equal(count, 0);
});
