import { test } from 'node:test';
import assert from 'node:assert';
import { createTelegramChannel, chunkText, TELEGRAM_MAX_TEXT } from '../src/telegram.js';
import { nullLogger } from './helpers.js';

/** A fake Bot API: records calls, serves getMe, hands out queued updates once, then blocks until aborted. */
function fakeApi(updates = []) {
  const calls = [];
  let served = false;
  const fetch = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    const ok = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
    if (method === 'getMe') return ok({ id: 1, username: 'alba_bot' });
    if (method === 'sendMessage') return ok({ message_id: calls.length });
    if (method === 'getUpdates') {
      if (!served) { served = true; return ok(updates); }
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, description: 'unknown method' }) };
  };
  return { fetch, calls };
}

test('connect polls, delivers allowed messages, advances the offset, disconnect stops', async () => {
  const api = fakeApi([
    { update_id: 10, message: { chat: { id: 42 }, from: { username: 'melvin' }, text: 'hello' } },
    { update_id: 11, message: { chat: { id: 77 }, from: {}, text: 'spam' } },
  ]);
  const received = [];
  const ch = createTelegramChannel({
    botToken: '1:t', allowFrom: ['42'], logger: nullLogger, fetch: api.fetch, pollTimeout: 0,
    onMessage: (peer, text) => received.push({ peer, text }),
  });
  assert.equal(ch.isConnected(), false);
  await ch.connect();
  assert.equal(ch.username, '@alba_bot');
  assert.equal(ch.isConnected(), true);
  // let the poll loop run its first two iterations
  for (let i = 0; i < 20 && api.calls.filter((c) => c.method === 'getUpdates').length < 2; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.deepEqual(received, [{ peer: '42', text: 'hello' }]);
  const polls = api.calls.filter((c) => c.method === 'getUpdates');
  assert.equal(polls[0].body.offset, 0);
  assert.equal(polls[1].body.offset, 12);
  await ch.disconnect();
  assert.equal(ch.isConnected(), false);
});

test('sendMessage chunks long text at the Telegram limit', async () => {
  const api = fakeApi();
  const ch = createTelegramChannel({ botToken: '1:t', allowFrom: ['1'], logger: nullLogger, fetch: api.fetch, onMessage: () => {} });
  const long = 'line\n'.repeat(1500); // 7500 chars
  await ch.sendMessage('42', long);
  const sent = api.calls.filter((c) => c.method === 'sendMessage');
  assert.equal(sent.length, 2);
  assert.ok(sent.every((c) => c.body.text.length <= TELEGRAM_MAX_TEXT && c.body.chat_id === '42'));
  assert.equal(sent.map((c) => c.body.text).join('\n'), long);
});

test('chunkText prefers newlines, then spaces, then hard cuts', () => {
  assert.deepEqual(chunkText('short'), ['short']);
  assert.deepEqual(chunkText(''), ['']);
  assert.deepEqual(chunkText('aaaa\nbbbb', 6), ['aaaa', 'bbbb']);
  assert.deepEqual(chunkText('aaaa bbbb', 6), ['aaaa', 'bbbb']);
  assert.deepEqual(chunkText('aaaaaaaaaa', 4), ['aaaa', 'aaaa', 'aa']);
});

test('open policy answers anyone; ownsJid matches numeric chat ids; API errors surface', async () => {
  const api = fakeApi();
  const received = [];
  const ch = createTelegramChannel({ botToken: '1:t', open: true, logger: nullLogger, fetch: api.fetch, onMessage: (p, t) => received.push(p) });
  ch.handleUpdate({ update_id: 1, message: { chat: { id: -100123 }, from: {}, text: 'group' } });
  assert.deepEqual(received, ['-100123']);
  assert.equal(ch.ownsJid('-100123'), true);
  assert.equal(ch.ownsJid('npub1abc'), false);
  const bad = createTelegramChannel({ botToken: '1:t', fetch: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) }), onMessage: () => {}, logger: nullLogger });
  await assert.rejects(() => bad.connect(), /telegram getMe: Unauthorized/);
  assert.throws(() => createTelegramChannel({ onMessage: () => {} }), /botToken is required/);
});
