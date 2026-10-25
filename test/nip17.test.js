import { test } from 'node:test';
import assert from 'node:assert';
import {
  getPublicKey, generatePrivateKey, finalizeEvent, eventId, verifyEvent, nip04Encrypt, nip04Decrypt,
  createChatRumor, giftWrap, unwrapGiftWrap, createNostrChannel,
} from '../src/nostr.js';
import { getConversationKey, encrypt as nip44Encrypt } from '../src/nip44.js';
import { nullLogger, startMockRelay } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

function captureLogger() {
  const warns = [];
  return { warns, logger: { ...nullLogger, warn: (msg, meta) => warns.push({ msg, meta }) } };
}

/** Agent channel on a mock relay plus a raw websocket "client" to inject events. */
async function setup({ allowFrom = [], open = false, dm, relayOpts } = {}) {
  const relay = await startMockRelay(relayOpts);
  const agentKey = generatePrivateKey();
  const received = [];
  const { warns, logger } = captureLogger();
  const channel = createNostrChannel({
    privateKey: agentKey,
    relays: [relay.url],
    allowedPubkeys: allowFrom,
    open,
    ...(dm && { dm }),
    onMessage: (jid, text, event) => received.push({ jid, text, event }),
    logger,
  });
  await channel.connect();
  assert.ok(await waitFor(() => channel.isConnected()), 'channel connected');
  await sleep(50); // REQs land

  const client = new WebSocket(relay.url);
  await new Promise((r) => { client.onopen = r; });
  const publish = (ev) => client.send(JSON.stringify(['EVENT', ev]));

  const teardown = async () => {
    client.close();
    await channel.disconnect();
    await relay.stop();
  };
  return { relay, agentKey, channel, received, warns, publish, teardown };
}

test('gift wrap/unwrap roundtrip: shapes per NIP-17/NIP-59', () => {
  const a = generatePrivateKey();
  const b = generatePrivateKey();
  const aPub = getPublicKey(a);
  const bPub = getPublicKey(b);

  const rumor = createChatRumor(aPub, bPub, 'hola, que tal? 🦞');
  assert.equal(rumor.kind, 14);
  assert.equal(rumor.sig, undefined, 'rumor is unsigned');
  assert.match(rumor.id, /^[0-9a-f]{64}$/);

  const wrap = giftWrap(rumor, a, bPub);
  const now = Math.floor(Date.now() / 1000);
  assert.equal(wrap.kind, 1059);
  assert.notEqual(wrap.pubkey, aPub, 'wrap is signed by an ephemeral key');
  assert.deepEqual(wrap.tags, [['p', bPub]]);
  assert.ok(verifyEvent(wrap));
  assert.ok(wrap.created_at <= now && wrap.created_at >= now - 2 * 24 * 3600);

  const { seal, rumor: opened } = unwrapGiftWrap(wrap, b);
  assert.equal(seal.kind, 13);
  assert.equal(seal.pubkey, aPub);
  assert.deepEqual(seal.tags, []);
  assert.ok(verifyEvent(seal));
  assert.deepEqual(opened, rumor);

  assert.throws(() => unwrapGiftWrap(wrap, generatePrivateKey()), /MAC/);
});

test('NIP-17 DM over the relay reaches onMessage as the seal signer', async () => {
  const userKey = generatePrivateKey();
  const userPub = getPublicKey(userKey);
  const s = await setup({ allowFrom: [userPub] });

  const wrap = giftWrap(createChatRumor(userPub, s.channel.publicKey, 'hello via nip17'), userKey, s.channel.publicKey);
  s.publish(wrap);
  assert.ok(await waitFor(() => s.received.length === 1));
  assert.equal(s.received[0].jid, userPub);
  assert.equal(s.received[0].text, 'hello via nip17');
  assert.equal(s.received[0].event.kind, 14);

  // Same wrap again (relay redelivery) → deduped
  s.publish(wrap);
  await sleep(300);
  assert.equal(s.received.length, 1, 'duplicate wrap delivered once');

  // Same rumor re-wrapped (fresh ephemeral key) → deduped by rumor id
  const rumor = s.received[0].event;
  s.publish(giftWrap(rumor, userKey, s.channel.publicKey));
  await sleep(400);
  assert.equal(s.received.length, 1, 'same rumor in a new wrap delivered once');

  await s.teardown();
});

test('NIP-17 rejections: spoofed rumor author, unauthorized sender, tampered ciphertext, old backlog', async () => {
  const userKey = generatePrivateKey();
  const userPub = getPublicKey(userKey);
  const s = await setup({ allowFrom: [userPub] });
  const agentPub = s.channel.publicKey;

  // Seal signed by a stranger, rumor claims to be the allowlisted user
  const strangerKey = generatePrivateKey();
  s.publish(giftWrap(createChatRumor(userPub, agentPub, 'I am totally the user'), strangerKey, agentPub));
  assert.ok(await waitFor(() => s.warns.some((w) => /spoof/.test(w.meta?.error))), 'spoof logged');

  // Honest stranger (not in allowFrom)
  s.publish(giftWrap(createChatRumor(getPublicKey(strangerKey), agentPub, 'let me in'), strangerKey, agentPub));

  // Tampered ciphertext under a valid outer signature
  const good = giftWrap(createChatRumor(userPub, agentPub, 'tamper me'), userKey, agentPub);
  const raw = Buffer.from(good.content, 'base64');
  raw[50] ^= 1;
  const eph = generatePrivateKey();
  const tampered = finalizeEvent({ kind: 1059, created_at: good.created_at, tags: good.tags, content: raw.toString('base64') }, eph);
  s.publish(tampered);
  assert.ok(await waitFor(() => s.warns.some((w) => /MAC/.test(w.meta?.error))), 'tamper logged');

  // Forged outer signature
  s.publish({ ...good, sig: '00'.repeat(64) });
  assert.ok(await waitFor(() => s.warns.some((w) => /bad signature/.test(w.msg))), 'bad sig logged');

  // A rumor from well before connect (old backlog) is not replayed
  const old = createChatRumor(userPub, agentPub, 'yesterday');
  old.created_at -= 3600;
  old.id = eventId(old);
  s.publish(giftWrap(old, userKey, agentPub));

  await sleep(500);
  assert.equal(s.received.length, 0, 'nothing reached onMessage');

  // The genuine one still gets through afterwards (the forged copy didn't shadow its id)
  s.publish(good);
  assert.ok(await waitFor(() => s.received.length === 1));
  assert.equal(s.received[0].text, 'tamper me');

  await s.teardown();
});

test('replies follow the peer: NIP-17 to a NIP-17 sender, NIP-04 to a NIP-04 sender', async () => {
  const aKey = generatePrivateKey();
  const aPub = getPublicKey(aKey);
  const dKey = generatePrivateKey();
  const dPub = getPublicKey(dKey);
  const s = await setup({ allowFrom: [aPub, dPub] });
  const agentPub = s.channel.publicKey;

  s.publish(giftWrap(createChatRumor(aPub, agentPub, 'hi (nip17)'), aKey, agentPub));
  s.publish(finalizeEvent({ kind: 4, tags: [['p', agentPub]], content: nip04Encrypt(dKey, agentPub, 'hi (nip04)') }, dKey));
  assert.ok(await waitFor(() => s.received.length === 2));

  await s.channel.sendMessage(aPub, 'reply to A');
  await s.channel.sendMessage(dPub, 'reply to D');
  await waitFor(() => s.relay.stored.filter((e) => e.pubkey === agentPub && e.kind === 4).length === 1
    && s.relay.stored.filter((e) => e.kind === 1059 && e.tags[0][1] === agentPub).length >= 1);

  // A gets a gift wrap it can open; the seal is ours
  const toA = s.relay.stored.filter((e) => e.kind === 1059 && e.tags[0][1] === aPub);
  assert.equal(toA.length, 1, 'one gift wrap to A');
  const { seal, rumor } = unwrapGiftWrap(toA[0], aKey);
  assert.equal(seal.pubkey, agentPub);
  assert.equal(rumor.content, 'reply to A');
  assert.deepEqual(rumor.tags, [['p', aPub]]);

  // Self-copy: same rumor wrapped to the agent, and it doesn't echo into onMessage
  const toSelf = s.relay.stored.filter((e) => e.kind === 1059 && e.tags[0][1] === agentPub && e.pubkey !== aPub);
  const selfCopies = toSelf.filter((w) => { try { return unwrapGiftWrap(w, s.agentKey).rumor.id === rumor.id; } catch { return false; } });
  assert.equal(selfCopies.length, 1, 'self-copy published');

  // D still gets plain NIP-04
  const toD = s.relay.stored.filter((e) => e.pubkey === agentPub && e.kind === 4);
  assert.equal(toD.length, 1);
  assert.equal(nip04Decrypt(dKey, agentPub, toD[0].content), 'reply to D');

  await sleep(300);
  assert.equal(s.received.length, 2, 'own messages never reach onMessage');
  await s.teardown();
});

test('dm: "nip17" forces gift wraps; dm validated', async () => {
  assert.throws(() => createNostrChannel({
    privateKey: generatePrivateKey(), relays: ['ws://x'], onMessage() {}, dm: 'nip99', logger: nullLogger,
  }), /dm must be/);

  const peerKey = generatePrivateKey();
  const peerPub = getPublicKey(peerKey);
  const s = await setup({ dm: 'nip17', allowFrom: [peerPub] });
  await s.channel.sendMessage(peerPub, 'forced');
  await waitFor(() => s.relay.stored.some((e) => e.kind === 1059 && e.tags[0][1] === peerPub));
  const wraps = s.relay.stored.filter((e) => e.kind === 1059 && e.tags[0][1] === peerPub);
  assert.equal(wraps.length, 1);
  assert.equal(unwrapGiftWrap(wraps[0], peerKey).rumor.content, 'forced');
  assert.equal(s.relay.stored.filter((e) => e.kind === 4).length, 0);
  await s.teardown();
});

test('NIP-17 send goes to the peer\'s kind-10050 inbox relays (with NIP-42 auth)', async () => {
  const inbox = await startMockRelay({ requireAuth: true });
  const peerKey = generatePrivateKey();
  const peerPub = getPublicKey(peerKey);
  const s = await setup({ dm: 'nip17', allowFrom: [peerPub] });

  // The peer advertises its DM inbox on the agent's relay
  s.publish(finalizeEvent({ kind: 10050, tags: [['relay', inbox.url]], content: '' }, peerKey));
  await waitFor(() => s.relay.stored.some((e) => e.kind === 10050));

  await s.channel.sendMessage(peerPub, 'to your inbox');

  const atInbox = inbox.stored.filter((e) => e.kind === 1059 && e.tags[0][1] === peerPub);
  assert.equal(atInbox.length, 1, 'wrap landed on the inbox relay');
  assert.equal(unwrapGiftWrap(atInbox[0], peerKey).rumor.content, 'to your inbox');
  assert.deepEqual(inbox.authed, [s.channel.publicKey], 'authenticated as the agent');
  assert.equal(s.relay.stored.filter((e) => e.kind === 1059 && e.tags[0][1] === peerPub).length, 0,
    'not published to relays outside the peer\'s inbox list');

  await s.teardown();
  await inbox.stop();
});

test('NIP-44 payload helpers interoperate with the seal layer', () => {
  // A hand-built seal (as another client would make it) opens with unwrapGiftWrap
  const a = generatePrivateKey();
  const b = generatePrivateKey();
  const aPub = getPublicKey(a);
  const bPub = getPublicKey(b);
  const rumor = createChatRumor(aPub, bPub, 'interop');
  const seal = finalizeEvent({ kind: 13, tags: [], content: nip44Encrypt(JSON.stringify(rumor), getConversationKey(a, bPub)) }, a);
  const eph = generatePrivateKey();
  const wrap = finalizeEvent({ kind: 1059, tags: [['p', bPub]], content: nip44Encrypt(JSON.stringify(seal), getConversationKey(eph, bPub)) }, eph);
  assert.equal(unwrapGiftWrap(wrap, b).rumor.content, 'interop');
});
