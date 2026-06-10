import { test } from 'node:test';
import assert from 'node:assert';
import { ChannelManager } from '../src/channel.js';
import { nullLogger } from './helpers.js';

function makeChannel(name, prefix, { connected = true } = {}) {
  let isUp = connected;
  const sent = [];
  return {
    sent,
    name,
    connect: async () => { isUp = true; },
    disconnect: async () => { isUp = false; },
    isConnected: () => isUp,
    ownsJid: (jid) => jid.startsWith(prefix),
    sendMessage: async (jid, text, sender) => { sent.push({ jid, text, sender }); },
  };
}

test('routes messages by ownsJid', async () => {
  const mgr = new ChannelManager({ logger: nullLogger });
  const tg = makeChannel('telegram', 'tg:');
  const dc = makeChannel('discord', 'dc:');
  mgr.register(tg);
  mgr.register(dc);

  assert.equal(await mgr.sendMessage('tg:1', 'hi'), true);
  assert.equal(await mgr.sendMessage('dc:2', 'yo', 'Alt'), true);
  assert.deepEqual(tg.sent, [{ jid: 'tg:1', text: 'hi', sender: undefined }]);
  assert.deepEqual(dc.sent, [{ jid: 'dc:2', text: 'yo', sender: 'Alt' }]);
});

test('refuses unowned JIDs and disconnected channels', async () => {
  const mgr = new ChannelManager({ logger: nullLogger });
  const down = makeChannel('down', 'd:', { connected: false });
  mgr.register(down);

  assert.equal(await mgr.sendMessage('x:1', 'no owner'), false);
  assert.equal(await mgr.sendMessage('d:1', 'down'), false);
  assert.equal(down.sent.length, 0);

  await mgr.connectAll();
  assert.equal(await mgr.sendMessage('d:1', 'up now'), true);
});

test('registration validation', () => {
  const mgr = new ChannelManager({ logger: nullLogger });
  mgr.register(makeChannel('a', 'a:'));
  assert.throws(() => mgr.register(makeChannel('a', 'a2:')), /already registered/);
  assert.throws(() => mgr.register({ name: 'broken' }), /ownsJid/);
});

test('one failing channel does not block connectAll', async () => {
  const mgr = new ChannelManager({ logger: nullLogger });
  const good = makeChannel('good', 'g:', { connected: false });
  mgr.register({
    ...makeChannel('bad', 'b:'),
    connect: async () => { throw new Error('auth expired'); },
  });
  mgr.register(good);

  await mgr.connectAll(); // must not reject
  assert.equal(good.isConnected(), true);
});

test('channelFor and list', () => {
  const mgr = new ChannelManager({ logger: nullLogger });
  const tg = makeChannel('telegram', 'tg:');
  mgr.register(tg);
  assert.equal(mgr.channelFor('tg:9').name, 'telegram');
  assert.equal(mgr.channelFor('zz:9'), undefined);
  assert.deepEqual(mgr.list().map((c) => c.name), ['telegram']);
});
