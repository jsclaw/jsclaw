import { test } from 'node:test';
import assert from 'node:assert';
import { createECDH, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  getPublicKey, generatePrivateKey, schnorrSign, schnorrVerify,
  nip04Encrypt, nip04Decrypt, eventId, finalizeEvent, verifyEvent,
  bech32Encode, bech32Decode, createNostrChannel,
} from '../src/nostr.js';
import { acceptKey, attachWebSocket } from '../src/ws.js';
import { nullLogger } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- BIP340 / secp256k1 ---

// Official vectors from bitcoin/bips bip-0340/test-vectors.csv
const BIP340_VECTORS = [
  {
    seckey: '0000000000000000000000000000000000000000000000000000000000000003',
    pubkey: 'F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9',
    aux: '0000000000000000000000000000000000000000000000000000000000000000',
    msg: '0000000000000000000000000000000000000000000000000000000000000000',
    sig: 'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0',
  },
  {
    seckey: 'B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF',
    pubkey: 'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
    aux: '0000000000000000000000000000000000000000000000000000000000000001',
    msg: '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    sig: '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A',
  },
  {
    seckey: 'C90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B14E5C9',
    pubkey: 'DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8',
    aux: 'C87AA53824B4D7AE2EB035A2B5BBBCCC080E76CDC6D1692C4B0B62D798E6D906',
    msg: '7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C',
    sig: '5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1BAB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7',
  },
  {
    // "test fails if msg is reduced modulo p or n"
    seckey: '0B432B2677937381AEF05BB02A66ECD012773062CF3FA2549E44F58ED2401710',
    pubkey: '25D1DFF95105F5253C4022F628A996AD3A0D95FBF21D468A1B33F8C160D8F517',
    aux: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    msg: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    sig: '7EB0509757E246F19449885651611CB965ECC1A187DD51B64FDA1EDC9637D5EC97582B9CB13DB3933705B32BA982AF5AF25FD78881EBB32771FC5922EFC66EA3',
  },
];

test('BIP340 official test vectors 0-3 (sign + verify)', () => {
  for (const [i, v] of BIP340_VECTORS.entries()) {
    assert.equal(getPublicKey(v.seckey.toLowerCase()).toUpperCase(), v.pubkey, `vector ${i} pubkey`);

    const sig = schnorrSign(Buffer.from(v.msg, 'hex'), v.seckey.toLowerCase(), Buffer.from(v.aux, 'hex'));
    assert.equal(sig.toString('hex').toUpperCase(), v.sig, `vector ${i} signature`);
    assert.ok(schnorrVerify(Buffer.from(v.msg, 'hex'), getPublicKey(v.seckey.toLowerCase()), sig), `vector ${i} verifies`);
  }
});

test('pubkeys agree with node:crypto ECDH (independent implementation)', () => {
  for (let i = 0; i < 8; i++) {
    const priv = generatePrivateKey();
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from(priv, 'hex'));
    // ECDH compressed pubkey = 02/03 prefix + x-coordinate
    const expectedX = ecdh.getPublicKey(null, 'compressed').subarray(1).toString('hex');
    assert.equal(getPublicKey(priv), expectedX, `key ${i} x-coordinate matches node:crypto`);
  }
});

test('sign/verify roundtrip; tampering is rejected', () => {
  const priv = generatePrivateKey();
  const pub = getPublicKey(priv);
  const msg = randomBytes(32);
  const sig = schnorrSign(msg, priv);

  assert.ok(schnorrVerify(msg, pub, sig));

  const tamperedSig = Buffer.from(sig);
  tamperedSig[10] ^= 0x01;
  assert.ok(!schnorrVerify(msg, pub, tamperedSig));

  const tamperedMsg = Buffer.from(msg);
  tamperedMsg[0] ^= 0x01;
  assert.ok(!schnorrVerify(tamperedMsg, pub, sig));

  const otherPub = getPublicKey(generatePrivateKey());
  assert.ok(!schnorrVerify(msg, otherPub, sig));
});

// --- NIP-04 ---

test('NIP-04 encrypt/decrypt roundtrip in both directions', () => {
  const alice = generatePrivateKey();
  const bob = generatePrivateKey();
  const alicePub = getPublicKey(alice);
  const bobPub = getPublicKey(bob);

  const content = nip04Encrypt(alice, bobPub, 'hello from alice — čau! 🦞');
  assert.match(content, /\?iv=/);
  assert.equal(nip04Decrypt(bob, alicePub, content), 'hello from alice — čau! 🦞');

  const reply = nip04Encrypt(bob, alicePub, 'hi alice');
  assert.equal(nip04Decrypt(alice, bobPub, reply), 'hi alice');
});

test('NIP-04 decryption fails for the wrong key pair', () => {
  const alice = generatePrivateKey();
  const bob = generatePrivateKey();
  const eve = generatePrivateKey();

  const content = nip04Encrypt(alice, getPublicKey(bob), 'secret');
  // Unauthenticated AES-CBC: a wrong key usually throws on padding, but
  // ~1/256 runs produces valid padding and returns garbage — either way
  // it must never yield the plaintext. (Was a CI flake.)
  let decrypted = null;
  try { decrypted = nip04Decrypt(eve, getPublicKey(alice), content); } catch { /* expected most runs */ }
  assert.notEqual(decrypted, 'secret');
});

// --- events ---

test('finalizeEvent produces a valid, verifiable event', () => {
  const priv = generatePrivateKey();
  const event = finalizeEvent({ kind: 4, tags: [['p', 'ab'.repeat(32)]], content: 'x' }, priv);

  assert.equal(event.pubkey, getPublicKey(priv));
  assert.equal(event.id, eventId(event));
  assert.ok(verifyEvent(event));

  // Tampered content invalidates the id
  assert.ok(!verifyEvent({ ...event, content: 'tampered' }));
  // Forged id without a matching signature fails too
  const forged = { ...event, content: 'tampered' };
  forged.id = eventId(forged);
  assert.ok(!verifyEvent(forged));
});

// --- bech32 ---

test('npub/nsec roundtrip and checksum enforcement', () => {
  const priv = generatePrivateKey();
  const pub = getPublicKey(priv);

  const npub = bech32Encode('npub', pub);
  const nsec = bech32Encode('nsec', priv);
  assert.ok(npub.startsWith('npub1'));
  assert.ok(nsec.startsWith('nsec1'));

  assert.deepEqual(bech32Decode(npub), { hrp: 'npub', hex: pub });
  assert.deepEqual(bech32Decode(nsec), { hrp: 'nsec', hex: priv });

  // Flip a character → checksum failure
  const corrupted = npub.slice(0, -1) + (npub.endsWith('q') ? 'p' : 'q');
  assert.throws(() => bech32Decode(corrupted), /checksum|character/);
});

// --- mock relay (built on jsclaw's own ws.js) ---

function startMockRelay() {
  const stored = [];
  const subs = new Map(); // conn -> { subId, filter }

  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    const conn = {};
    const ws = attachWebSocket(socket, {
      onMessage: (text) => {
        const frame = JSON.parse(text);
        if (frame[0] === 'REQ') {
          const [, subId, filter] = frame;
          subs.set(conn, { subId, filter });
          for (const ev of stored) {
            if (matches(filter, ev)) ws.send(JSON.stringify(['EVENT', subId, ev]));
          }
          ws.send(JSON.stringify(['EOSE', subId]));
        } else if (frame[0] === 'EVENT') {
          const ev = frame[1];
          stored.push(ev);
          conn.ws.send(JSON.stringify(['OK', ev.id, true, '']));
          for (const [c, sub] of subs) {
            if (matches(sub.filter, ev)) c.ws.send(JSON.stringify(['EVENT', sub.subId, ev]));
          }
        } else if (frame[0] === 'CLOSE') {
          subs.delete(conn);
        }
      },
      onClose: () => subs.delete(conn),
    }, head);
    conn.ws = ws;
  });

  function matches(filter, ev) {
    if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
    if (filter['#p']) {
      const ps = ev.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
      if (!filter['#p'].some((p) => ps.includes(p))) return false;
    }
    if (filter.since && ev.created_at < filter.since) return false;
    return true;
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `ws://127.0.0.1:${server.address().port}`,
        stored,
        stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

test('channel E2E over a mock relay: encrypted DMs both ways, allowlist enforced', async () => {
  const relay = await startMockRelay();

  const agentKey = generatePrivateKey();
  const userKey = generatePrivateKey();
  const strangerKey = generatePrivateKey();
  const userPub = getPublicKey(userKey);

  const received = [];
  const channel = createNostrChannel({
    privateKey: agentKey,
    relays: [relay.url],
    allowedPubkeys: [userPub],
    onMessage: (jid, text) => received.push({ jid, text }),
    logger: nullLogger,
  });

  assert.equal(channel.publicKey, getPublicKey(agentKey));
  assert.ok(channel.npub.startsWith('npub1'));
  assert.ok(channel.ownsJid(userPub));
  assert.ok(channel.ownsJid(channel.npub));
  assert.ok(!channel.ownsJid('tg:12345'));

  await channel.connect();
  await sleep(100);
  assert.ok(channel.isConnected());

  // User DMs the agent through the relay (raw client, real protocol)
  const userWs = new WebSocket(relay.url);
  await new Promise((r) => { userWs.onopen = r; });

  const dm = finalizeEvent({
    kind: 4,
    tags: [['p', channel.publicKey]],
    content: nip04Encrypt(userKey, channel.publicKey, 'hello agent'),
  }, userKey);
  userWs.send(JSON.stringify(['EVENT', dm]));
  await sleep(150);

  assert.deepEqual(received, [{ jid: userPub, text: 'hello agent' }]);

  // Stranger's DM is dropped by the allowlist
  const strangerDm = finalizeEvent({
    kind: 4,
    tags: [['p', channel.publicKey]],
    content: nip04Encrypt(strangerKey, channel.publicKey, 'let me in'),
  }, strangerKey);
  userWs.send(JSON.stringify(['EVENT', strangerDm]));
  await sleep(150);
  assert.equal(received.length, 1, 'unauthorized DM never reached onMessage');

  // Agent replies; the user can decrypt it
  await channel.sendMessage(userPub, 'hello user');
  await sleep(150);
  const reply = relay.stored.find((ev) => ev.pubkey === channel.publicKey);
  assert.ok(reply, 'reply published to the relay');
  assert.ok(verifyEvent(reply));
  assert.deepEqual(reply.tags, [['p', userPub]]);
  assert.equal(nip04Decrypt(userKey, channel.publicKey, reply.content), 'hello user');

  // Duplicate delivery is ignored
  userWs.send(JSON.stringify(['EVENT', dm]));
  await sleep(150);
  assert.equal(received.length, 1, 'duplicate event deduped');

  userWs.close();
  await channel.disconnect();
  assert.ok(!channel.isConnected());
  await relay.stop();
});

test('channel rejects forged events (bad signature)', async () => {
  const relay = await startMockRelay();
  const agentKey = generatePrivateKey();
  const userKey = generatePrivateKey();

  const received = [];
  const channel = createNostrChannel({
    privateKey: agentKey,
    relays: [relay.url],
    open: true,
    onMessage: (jid, text) => received.push(text),
    logger: nullLogger,
  });
  await channel.connect();
  await sleep(100);

  const forged = finalizeEvent({
    kind: 4,
    tags: [['p', channel.publicKey]],
    content: nip04Encrypt(userKey, channel.publicKey, 'forged'),
  }, userKey);
  forged.pubkey = getPublicKey(generatePrivateKey()); // claim another identity

  const ws = new WebSocket(relay.url);
  await new Promise((r) => { ws.onopen = r; });
  ws.send(JSON.stringify(['EVENT', forged]));
  await sleep(150);

  assert.equal(received.length, 0, 'forged event dropped');

  ws.close();
  await channel.disconnect();
  await relay.stop();
});
