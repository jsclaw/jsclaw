/**
 * Channel registry tests — openclaw config shapes (enabled, dmPolicy,
 * allowFrom), bindings routing, per-peer sessions. Mock channel only.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { startChannels, validateChannelBlock } from '../src/channels.js';
import { nullLogger, tempConfig } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockRegistry() {
  const state = { ctx: null, sent: [] };
  return {
    state,
    registry: {
      mock: (block, ctx) => {
        state.ctx = ctx;
        state.block = block;
        return {
          name: 'mock',
          connected: false,
          async connect() { this.connected = true; },
          async disconnect() { this.connected = false; },
          async sendMessage(jid, text) { state.sent.push({ jid, text }); },
        };
      },
    },
  };
}

function fakeRunAgent(calls, outputs = [{ status: 'success', result: 'reply', newSessionId: 's1' }]) {
  return async (agentId, prompt, onOutput, extra = {}) => {
    calls.push({ agentId, prompt, extra });
    for (const output of outputs) await onOutput(output);
    return outputs[outputs.length - 1];
  };
}

const baseConfig = (channels, bindings) => ({
  ...tempConfig(),
  channels,
  bindings,
  logger: nullLogger,
});

test('validateChannelBlock enforces openclaw dmPolicy semantics', () => {
  assert.deepEqual(
    validateChannelBlock('x', { allowFrom: ['a'] }),
    { dmPolicy: 'allowlist', allowFrom: ['a'] },
  );
  assert.throws(() => validateChannelBlock('x', {}), /allowFrom is required/);
  assert.throws(() => validateChannelBlock('x', { dmPolicy: 'open' }), /requires channels.x.allowFrom to include "\*"/);
  assert.throws(() => validateChannelBlock('x', { dmPolicy: 'pairing' }), /not yet supported/);
  assert.deepEqual(
    validateChannelBlock('x', { dmPolicy: 'open', allowFrom: ['*'] }),
    { dmPolicy: 'open', allowFrom: ['*'] },
  );
});

test('disabled and absent channels start nothing; unknown channels fail', async () => {
  const { registry } = mockRegistry();
  const none = await startChannels({ config: baseConfig({ mock: { enabled: false, allowFrom: ['a'] } }), runAgent: fakeRunAgent([]), registry, logger: nullLogger });
  assert.equal(none.channels.length, 0);

  await assert.rejects(
    () => startChannels({ config: baseConfig({ nope: { allowFrom: ['a'] } }), runAgent: fakeRunAgent([]), registry, logger: nullLogger }),
    /unknown channel: nope/,
  );
});

test('messages route through bindings, fall back to main, and reply via the channel', async () => {
  const { registry, state } = mockRegistry();
  const calls = [];
  const config = baseConfig(
    { mock: { allowFrom: ['p1', 'p2'] } },
    [{ match: { channel: 'mock', peer: 'p2' }, agentId: 'special' }],
  );
  const running = await startChannels({ config, runAgent: fakeRunAgent(calls), registry, logger: nullLogger });
  assert.equal(running.channels[0].connected, true);
  assert.deepEqual(state.ctx.allowFrom, ['p1', 'p2']);

  state.ctx.onMessage('p1', 'hello');
  state.ctx.onMessage('p2', 'hi');
  await sleep(20);

  assert.equal(calls[0].agentId, 'main');
  assert.equal(calls[1].agentId, 'special');
  assert.deepEqual(state.sent.map((s) => s.jid), ['p1', 'p2']);

  await running.stop();
  assert.equal(running.channels[0].connected, false);
});

test('sessions thread per (channel, peer)', async () => {
  const { registry, state } = mockRegistry();
  const calls = [];
  const config = baseConfig({ mock: { allowFrom: ['p1'] } });
  await startChannels({ config, runAgent: fakeRunAgent(calls), registry, logger: nullLogger });

  state.ctx.onMessage('p1', 'first');
  await sleep(20);
  state.ctx.onMessage('p1', 'second');
  await sleep(20);

  assert.equal(calls[0].extra.sessionId, undefined);
  assert.equal(calls[1].extra.sessionId, 's1'); // newSessionId from the first run
});

test('agent failures apologize instead of going silent', async () => {
  const { registry, state } = mockRegistry();
  const config = baseConfig({ mock: { allowFrom: ['p1'] } });
  await startChannels({
    config,
    runAgent: async () => { throw new Error('boom'); },
    registry,
    logger: nullLogger,
  });

  state.ctx.onMessage('p1', 'hello');
  await sleep(20);
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].text, /went wrong/);
});

test('nostr factory maps registry ctx onto createNostrChannel and rejects legacy fields', async () => {
  const { CHANNEL_FACTORIES } = await import('../src/channels.js');
  const { generatePrivateKey } = await import('../src/nostr.js');
  const key = generatePrivateKey();

  const ch = CHANNEL_FACTORIES.nostr(
    { privateKey: key, relays: ['wss://example.invalid'] },
    { allowFrom: [], open: true, logger: nullLogger, onMessage: () => {} },
  );
  assert.equal(ch.name, 'nostr');
  assert.match(ch.npub, /^npub1/);

  assert.throws(() => CHANNEL_FACTORIES.nostr({}, {}), /privateKey is required/);
  assert.throws(() => CHANNEL_FACTORIES.nostr({ privateKey: key, allowed: ['x'] }, {}), /renamed to 'allowFrom'/);
  assert.throws(() => CHANNEL_FACTORIES.nostr({ privateKey: key, agentId: 'main' }, {}), /route with bindings/);
});

test('telegram factory filters by allowFrom and maps messages', async () => {
  const { CHANNEL_FACTORIES } = await import('../src/channels.js');
  const received = [];
  // botInfo provided so grammy can handle updates offline (no getMe call)
  const botInfo = { id: 1, is_bot: true, first_name: 'T', username: 'test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
  const ch = await CHANNEL_FACTORIES.telegram(
    { botToken: '1:test', botInfo },
    { allowFrom: ['42', '@melvin'], open: false, logger: nullLogger, onMessage: (peer, text) => received.push({ peer, text }) },
  );
  assert.equal(ch.name, 'telegram');

  const update = (id, chatId, text, username) => ({
    update_id: id,
    message: { message_id: id, date: 1, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'x', ...(username ? { username } : {}) }, text },
  });

  await ch._bot.handleUpdate(update(1, 42, 'allowed by chat id'));
  await ch._bot.handleUpdate(update(2, 99, 'allowed by username', 'melvin'));
  await ch._bot.handleUpdate(update(3, 77, 'not allowed'));

  assert.deepEqual(received, [
    { peer: '42', text: 'allowed by chat id' },
    { peer: '99', text: 'allowed by username' },
  ]);

  await assert.rejects(() => CHANNEL_FACTORIES.telegram({}, {}), /botToken is required/);
});
