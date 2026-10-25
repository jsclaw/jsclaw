/**
 * Nostr channel — decentralized encrypted DMs for jsclaw agents.
 * Zero dependencies: secp256k1 in pure BigInt (affine — auditable over
 * fast; DM volume doesn't need Jacobian), BIP340 Schnorr via tagged
 * SHA-256, NIP-04 encryption via node:crypto, NIP-17 gift-wrapped DMs
 * over NIP-44 (./nip44.js), relays via Node's native WebSocket client.
 *
 * Talk to your containerized agent from any Nostr client. No bot
 * tokens, no platform accounts, no central server.
 * @module nostr
 */

import { createHash, randomBytes, randomInt, createCipheriv, createDecipheriv } from 'node:crypto';
import { createLogger } from './logger.js';
import { getConversationKey, encrypt as nip44Encrypt, decrypt as nip44Decrypt } from './nip44.js';

// --- secp256k1 (pure BigInt, affine coordinates) ---

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const G = {
  x: 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
  y: 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n,
};

const mod = (a, m = P) => ((a % m) + m) % m;

function modpow(base, exp, m) {
  let result = 1n;
  base = mod(base, m);
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return result;
}

const modinv = (a, m = P) => modpow(mod(a, m), m - 2n, m); // Fermat: m prime

/** @typedef {{x: bigint, y: bigint}|null} Point - null is the point at infinity */

/** @param {Point} a @param {Point} b @returns {Point} */
function pointAdd(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  if (a.x === b.x && mod(a.y + b.y) === 0n) return null;

  let slope;
  if (a.x === b.x && a.y === b.y) {
    if (a.y === 0n) return null;
    slope = mod(3n * a.x * a.x * modinv(2n * a.y));
  } else {
    slope = mod((b.y - a.y) * modinv(b.x - a.x));
  }
  const x = mod(slope * slope - a.x - b.x);
  const y = mod(slope * (a.x - x) - a.y);
  return { x, y };
}

/** @param {bigint} k @param {Point} point @returns {Point} */
function pointMul(k, point) {
  let result = null;
  let addend = point;
  k = mod(k, N);
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    k >>= 1n;
  }
  return result;
}

/** Lift an x-only coordinate to the curve point with even y (BIP340). */
function liftX(x) {
  if (x >= P) throw new Error('x out of range');
  const ySq = mod(modpow(x, 3n, P) + 7n);
  const y = modpow(ySq, (P + 1n) / 4n, P);
  if ((y * y) % P !== ySq) throw new Error('not a curve point');
  return { x, y: y % 2n === 0n ? y : P - y };
}

// --- encoding helpers ---

const bytesToBig = (buf) => BigInt('0x' + buf.toString('hex'));
const bigToBytes = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const sha256 = (...bufs) => createHash('sha256').update(Buffer.concat(bufs)).digest();

const TAG_CACHE = new Map();
function taggedHash(tag, ...data) {
  if (!TAG_CACHE.has(tag)) {
    const t = sha256(Buffer.from(tag, 'utf-8'));
    TAG_CACHE.set(tag, Buffer.concat([t, t]));
  }
  return sha256(TAG_CACHE.get(tag), ...data);
}

// --- keys & signatures (BIP340) ---

/**
 * Derive the x-only public key (hex) for a private key.
 * @param {string} privkeyHex - 32-byte hex
 * @returns {string} 32-byte x-only pubkey hex
 */
export function getPublicKey(privkeyHex) {
  const d = bytesToBig(Buffer.from(privkeyHex, 'hex'));
  if (d === 0n || d >= N) throw new Error('invalid private key');
  return bigToBytes(pointMul(d, G).x).toString('hex');
}

/** Generate a fresh private key (hex). */
export function generatePrivateKey() {
  while (true) {
    const candidate = randomBytes(32);
    const d = bytesToBig(candidate);
    if (d > 0n && d < N) return candidate.toString('hex');
  }
}

/**
 * BIP340 Schnorr signature.
 * @param {Buffer} msg32 - 32-byte message (the event id)
 * @param {string} privkeyHex
 * @param {Buffer} [auxRand] - 32 bytes auxiliary randomness (tests pass a fixed value)
 * @returns {Buffer} 64-byte signature
 */
export function schnorrSign(msg32, privkeyHex, auxRand = randomBytes(32)) {
  let d = bytesToBig(Buffer.from(privkeyHex, 'hex'));
  if (d === 0n || d >= N) throw new Error('invalid private key');

  const Pp = pointMul(d, G);
  if (Pp.y % 2n !== 0n) d = N - d;
  const pBytes = bigToBytes(Pp.x);

  const t = bigToBytes(d ^ bytesToBig(taggedHash('BIP0340/aux', auxRand)));
  let k = mod(bytesToBig(taggedHash('BIP0340/nonce', t, pBytes, msg32)), N);
  if (k === 0n) throw new Error('zero nonce');

  const R = pointMul(k, G);
  if (R.y % 2n !== 0n) k = N - k;
  const rBytes = bigToBytes(R.x);

  const e = mod(bytesToBig(taggedHash('BIP0340/challenge', rBytes, pBytes, msg32)), N);
  return Buffer.concat([rBytes, bigToBytes(mod(k + e * d, N))]);
}

/**
 * BIP340 Schnorr verification.
 * @param {Buffer} msg32
 * @param {string} pubkeyHex - x-only
 * @param {Buffer} sig64
 * @returns {boolean}
 */
export function schnorrVerify(msg32, pubkeyHex, sig64) {
  try {
    const Pp = liftX(bytesToBig(Buffer.from(pubkeyHex, 'hex')));
    const r = bytesToBig(sig64.subarray(0, 32));
    const s = bytesToBig(sig64.subarray(32, 64));
    if (r >= P || s >= N) return false;

    const e = mod(bytesToBig(taggedHash('BIP0340/challenge', sig64.subarray(0, 32), Buffer.from(pubkeyHex, 'hex'), msg32)), N);
    const R = pointAdd(pointMul(s, G), pointMul(N - e, Pp));
    return R !== null && R.y % 2n === 0n && R.x === r;
  } catch {
    return false;
  }
}

// --- NIP-04 encrypted DMs ---

/** ECDH shared X coordinate (NIP-04 uses it unhashed as the AES key). */
function sharedSecret(privkeyHex, pubkeyHex) {
  const d = bytesToBig(Buffer.from(privkeyHex, 'hex'));
  const point = pointMul(d, liftX(bytesToBig(Buffer.from(pubkeyHex, 'hex'))));
  return bigToBytes(point.x);
}

/**
 * Validated ECDH: the unhashed 32-byte x coordinate of privkey · pubkey
 * (NIP-44's `shared_x`). Rejects scalars outside [1, n-1] and x-only
 * pubkeys that aren't on the curve (twist points included).
 * @param {string} privkeyHex
 * @param {string} pubkeyHex - x-only
 * @returns {Buffer}
 */
export function sharedSecretX(privkeyHex, pubkeyHex) {
  if (!/^[0-9a-f]{64}$/i.test(privkeyHex)) throw new Error('invalid private key');
  if (!/^[0-9a-f]{64}$/i.test(pubkeyHex)) throw new Error('invalid public key');
  const d = bytesToBig(Buffer.from(privkeyHex, 'hex'));
  if (d === 0n || d >= N) throw new Error('invalid private key');
  const point = pointMul(d, liftX(bytesToBig(Buffer.from(pubkeyHex, 'hex'))));
  if (point === null) throw new Error('invalid shared point');
  return bigToBytes(point.x);
}

/**
 * @param {string} privkeyHex - Sender's private key
 * @param {string} pubkeyHex - Recipient's x-only pubkey
 * @param {string} text
 * @returns {string} NIP-04 content: base64(ciphertext)?iv=base64(iv)
 */
export function nip04Encrypt(privkeyHex, pubkeyHex, text) {
  const key = sharedSecret(privkeyHex, pubkeyHex);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf-8'), cipher.final()]);
  return `${ct.toString('base64')}?iv=${iv.toString('base64')}`;
}

/**
 * @param {string} privkeyHex - Recipient's private key
 * @param {string} pubkeyHex - Sender's x-only pubkey
 * @param {string} content - NIP-04 content
 * @returns {string} Plaintext
 * @throws {Error} when the content wasn't encrypted to this key pair
 */
export function nip04Decrypt(privkeyHex, pubkeyHex, content) {
  const [data, ivPart] = content.split('?iv=');
  if (!ivPart) throw new Error('invalid NIP-04 content');
  const key = sharedSecret(privkeyHex, pubkeyHex);
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(ivPart, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf-8');
}

// --- events (NIP-01) ---

/**
 * Compute a Nostr event id (hex).
 * @param {{ pubkey: string, created_at: number, kind: number, tags: string[][], content: string }} event
 */
export function eventId(event) {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return sha256(Buffer.from(serialized, 'utf-8')).toString('hex');
}

/**
 * Fill in pubkey, id, and sig for an event template.
 * @param {{ kind: number, tags?: string[][], content: string, created_at?: number }} template
 * @param {string} privkeyHex
 * @returns {Object} The signed event
 */
export function finalizeEvent(template, privkeyHex) {
  const event = {
    kind: template.kind,
    tags: template.tags || [],
    content: template.content,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
    pubkey: getPublicKey(privkeyHex),
  };
  event.id = eventId(event);
  event.sig = schnorrSign(Buffer.from(event.id, 'hex'), privkeyHex).toString('hex');
  return event;
}

/**
 * Verify an event's id and signature.
 * @param {Object} event
 * @returns {boolean}
 */
export function verifyEvent(event) {
  try {
    if (eventId(event) !== event.id) return false;
    return schnorrVerify(Buffer.from(event.id, 'hex'), event.pubkey, Buffer.from(event.sig, 'hex'));
  } catch {
    return false;
  }
}

// --- bech32 (BIP-173) for npub / nsec ---

const B32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const B32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function b32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= B32_GEN[i];
    }
  }
  return chk;
}

function b32HrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new Error('invalid bech32 padding');
  }
  return out;
}

/**
 * Encode 32 bytes as npub1... / nsec1...
 * @param {'npub'|'nsec'} hrp
 * @param {string} hex
 */
export function bech32Encode(hrp, hex) {
  const words = convertBits(Buffer.from(hex, 'hex'), 8, 5, true);
  const values = [...b32HrpExpand(hrp), ...words];
  const polymod = b32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  let checksum = '';
  for (let i = 0; i < 6; i++) checksum += B32_CHARSET[(polymod >> (5 * (5 - i))) & 31];
  return hrp + '1' + words.map((w) => B32_CHARSET[w]).join('') + checksum;
}

/**
 * Decode npub1... / nsec1... to { hrp, hex }.
 * @param {string} encoded
 */
export function bech32Decode(encoded) {
  const lower = encoded.toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 1) throw new Error('invalid bech32');
  const hrp = lower.slice(0, sep);
  const words = [...lower.slice(sep + 1)].map((c) => {
    const v = B32_CHARSET.indexOf(c);
    if (v === -1) throw new Error('invalid bech32 character');
    return v;
  });
  if (b32Polymod([...b32HrpExpand(hrp), ...words]) !== 1) throw new Error('bad bech32 checksum');
  const bytes = convertBits(words.slice(0, -6), 5, 8, false);
  return { hrp, hex: Buffer.from(bytes).toString('hex') };
}

/** Accept hex, nsec, or npub key input and return hex. */
function toHex(key, expectedHrp) {
  if (/^[0-9a-f]{64}$/i.test(key)) return key.toLowerCase();
  const { hrp, hex } = bech32Decode(key);
  if (hrp !== expectedHrp) throw new Error(`expected ${expectedHrp}, got ${hrp}`);
  return hex;
}

// --- NIP-17 private DMs (NIP-59 gift wrap over NIP-44) ---

/** Senders randomize seal/wrap created_at up to this far into the past. */
const GIFT_WRAP_WINDOW = 2 * 24 * 3600;

const nowSec = () => Math.floor(Date.now() / 1000);
const randomPast = () => nowSec() - randomInt(0, GIFT_WRAP_WINDOW);

/**
 * An unsigned kind-14 chat rumor (has an id, never a sig).
 * @param {string} senderPubkey
 * @param {string} recipientPubkey
 * @param {string} text
 */
export function createChatRumor(senderPubkey, recipientPubkey, text) {
  const rumor = {
    kind: 14,
    pubkey: senderPubkey,
    created_at: nowSec(),
    tags: [['p', recipientPubkey]],
    content: text,
  };
  rumor.id = eventId(rumor);
  return rumor;
}

/**
 * Seal a rumor with the sender's key (kind 13) and gift-wrap it (kind
 * 1059) to one recipient with a fresh ephemeral key.
 * @param {Object} rumor - Unsigned event
 * @param {string} senderPrivkey
 * @param {string} recipientPubkey
 * @returns {Object} Signed kind-1059 event
 */
export function giftWrap(rumor, senderPrivkey, recipientPubkey) {
  const seal = finalizeEvent({
    kind: 13,
    created_at: randomPast(),
    tags: [],
    content: nip44Encrypt(JSON.stringify(rumor), getConversationKey(senderPrivkey, recipientPubkey)),
  }, senderPrivkey);
  const ephemeral = generatePrivateKey();
  return finalizeEvent({
    kind: 1059,
    created_at: randomPast(),
    tags: [['p', recipientPubkey]],
    content: nip44Encrypt(JSON.stringify(seal), getConversationKey(ephemeral, recipientPubkey)),
  }, ephemeral);
}

/**
 * Open a kind-1059 gift wrap addressed to us. Verifies the seal's
 * signature and that the rumor's author is the seal's signer (anyone can
 * write any pubkey into an unsigned rumor). The outer wrap signature is
 * the caller's job (checked before spending an ECDH on it).
 * @param {Object} wrap
 * @param {string} recipientPrivkey
 * @returns {{ seal: Object, rumor: Object }} seal.pubkey is the real sender
 * @throws {Error} on any decryption or validation failure
 */
export function unwrapGiftWrap(wrap, recipientPrivkey) {
  if (wrap?.kind !== 1059) throw new Error('not a gift wrap');
  const seal = JSON.parse(nip44Decrypt(wrap.content, getConversationKey(recipientPrivkey, wrap.pubkey)));
  if (seal?.kind !== 13) throw new Error('inner event is not a seal');
  if (!verifyEvent(seal)) throw new Error('seal has a bad signature');
  const rumor = JSON.parse(nip44Decrypt(seal.content, getConversationKey(recipientPrivkey, seal.pubkey)));
  if (!rumor || typeof rumor !== 'object' || !Array.isArray(rumor.tags)) throw new Error('malformed rumor');
  if (rumor.pubkey !== seal.pubkey) throw new Error('rumor pubkey does not match seal signer (spoof attempt)');
  return { seal, rumor };
}

/** NIP-42 auth event for a relay challenge. */
function authEvent(url, challenge, privkey) {
  return finalizeEvent({ kind: 22242, tags: [['relay', url], ['challenge', challenge]], content: '' }, privkey);
}

const normUrl = (u) => String(u).trim().replace(/\/+$/, '');

function parseFrame(data) {
  try {
    const frame = JSON.parse(typeof data === 'string' ? data : data.toString());
    return Array.isArray(frame) ? frame : null;
  } catch {
    return null;
  }
}

// --- the channel ---

/**
 * Create a jsclaw Channel over Nostr encrypted DMs: NIP-04 (kind 4) and
 * NIP-17 (kind 1059 gift-wrapped kind 14, NIP-44 encrypted).
 *
 * Authorization is default-closed: only pubkeys in allowedPubkeys reach
 * onMessage, unless open: true is set explicitly. For NIP-17 the check
 * is against the seal signer, never the throwaway wrap key.
 *
 * Replies go out in the protocol the peer last used (dm: 'auto'), or
 * always NIP-04 / NIP-17 when dm is forced.
 *
 * @param {Object} options
 * @param {string} options.privateKey - Agent's key (hex or nsec)
 * @param {string[]} options.relays - Relay websocket URLs
 * @param {(jid: string, text: string, event: Object) => void} options.onMessage - Inbound DM (jid = sender pubkey hex; event = kind-4 event or kind-14 rumor)
 * @param {string[]} [options.allowedPubkeys] - Senders allowed to reach the agent (hex or npub)
 * @param {boolean} [options.open] - Accept DMs from anyone (explicit opt-in)
 * @param {'auto'|'nip04'|'nip17'} [options.dm='auto'] - Outbound DM protocol
 * @param {import('./types.js').Logger} [options.logger]
 * @returns {import('./channel.js').Channel & { publicKey: string, npub: string }}
 */
export function createNostrChannel(options) {
  const {
    privateKey,
    relays = [],
    onMessage,
    allowedPubkeys = [],
    open = false,
    dm = 'auto',
    logger = createLogger(),
  } = options;

  if (!privateKey) throw new Error('createNostrChannel requires a privateKey');
  if (relays.length === 0) throw new Error('createNostrChannel requires at least one relay');
  if (typeof onMessage !== 'function') throw new Error('createNostrChannel requires onMessage');
  if (!['auto', 'nip04', 'nip17'].includes(dm)) throw new Error(`createNostrChannel: dm must be "auto", "nip04" or "nip17" (got "${dm}")`);

  const privkey = toHex(privateKey, 'nsec');
  const pubkey = getPublicKey(privkey);
  const allowed = new Set(allowedPubkeys.map((k) => toHex(k, 'npub')));

  /** @type {Map<string, { ws: WebSocket|null, open: boolean, attempts: number }>} */
  const conns = new Map(relays.map((url) => [url, { ws: null, open: false, attempts: 0 }]));
  const seen = new Set();
  /** @type {Map<string, 'nip04'|'nip17'>} protocol each peer last wrote with */
  const peerProtocol = new Map();
  /** @type {Map<string, { relays: string[], at: number }>} kind-10050 cache */
  const inboxCache = new Map();
  const pending = new Map(); // query subId -> { onEvent, onEose, finish }
  let querySeq = 0;
  let closed = false;
  const sinceConnect = nowSec() - 10;

  // Gift-wrap timing rule. A wrap's created_at is randomized up to two days
  // into the past, so the kind-1059 REQ must reach back that far or it
  // misses almost every live message — which means each (re)connect also
  // replays up to two days of old wraps. Those are filtered on the rumor's
  // real created_at: a wrap is handled at most once (bounded seen set, by
  // wrap id and by rumor id) and only if rumor.created_at >= sinceConnect
  // - RUMOR_GRACE. The grace keeps messages sent just before a restart
  // (or while a relay lagged); older backlog is never fed to the agent.
  const RUMOR_GRACE = 600;

  /** @returns {boolean} true the first time an id is seen */
  function remember(id) {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 5000) {
      // Drop the oldest half; ids re-arriving later are harmless dupes
      const ids = [...seen];
      for (const old of ids.slice(0, 2500)) seen.delete(old);
    }
    return true;
  }

  function handleDm(event) {
    if (event.pubkey === pubkey) return;
    if (!remember(event.id)) return;

    if (!verifyEvent(event)) {
      logger.warn('Nostr: dropped event with bad signature', { id: event.id });
      return;
    }
    if (!open && !allowed.has(event.pubkey)) {
      logger.debug?.('Nostr: dropped DM from unauthorized pubkey', { pubkey: event.pubkey });
      return;
    }

    let text;
    try {
      text = nip04Decrypt(privkey, event.pubkey, event.content);
    } catch {
      logger.warn('Nostr: failed to decrypt DM', { from: event.pubkey });
      return;
    }
    peerProtocol.set(event.pubkey, 'nip04');
    onMessage(event.pubkey, text, event);
  }

  function handleGiftWrap(wrap) {
    if (seen.has(wrap.id)) return;
    if (!Array.isArray(wrap.tags) || !wrap.tags.some((t) => t[0] === 'p' && t[1] === pubkey)) return;
    // Outer signature first (NIP-44: validate before decrypting); only a
    // verified id goes in the seen set, so a forged copy can't shadow it.
    if (!verifyEvent(wrap)) {
      logger.warn('Nostr: dropped gift wrap with bad signature', { id: wrap.id });
      return;
    }
    remember(wrap.id);

    let seal, rumor;
    try {
      ({ seal, rumor } = unwrapGiftWrap(wrap, privkey));
    } catch (err) {
      logger.warn('Nostr: dropped gift wrap', { id: wrap.id, error: err.message });
      return;
    }
    const sender = seal.pubkey;
    if (sender === pubkey) return; // our own self-copy echoing back
    if (rumor.kind !== 14) {
      logger.debug?.('Nostr: ignored non-chat rumor', { kind: rumor.kind, from: sender });
      return;
    }
    if (!rumor.tags.some((t) => t[0] === 'p' && t[1] === pubkey)) {
      logger.debug?.('Nostr: dropped rumor not addressed to us', { from: sender });
      return;
    }
    if (!(rumor.created_at >= sinceConnect - RUMOR_GRACE)) return; // backlog, see timing rule
    if (!remember(`rumor:${eventId(rumor)}`)) return;
    if (!open && !allowed.has(sender)) {
      logger.debug?.('Nostr: dropped DM from unauthorized pubkey', { pubkey: sender });
      return;
    }
    if (typeof rumor.content !== 'string') return;

    peerProtocol.set(sender, 'nip17');
    onMessage(sender, rumor.content, rumor);
  }

  function handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.kind === 4) handleDm(event);
    else if (event.kind === 1059) handleGiftWrap(event);
  }

  function subscribe(ws) {
    ws.send(JSON.stringify(['REQ', 'jsclaw-dm', { kinds: [4], '#p': [pubkey], since: sinceConnect }]));
    ws.send(JSON.stringify(['REQ', 'jsclaw-gw', { kinds: [1059], '#p': [pubkey], since: sinceConnect - GIFT_WRAP_WINDOW }]));
  }

  function connectRelay(url) {
    if (closed) return;
    const state = conns.get(url);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      logger.warn(`Nostr: bad relay URL ${url}`, { error: err.message });
      return;
    }
    state.ws = ws;
    let authId = null;

    ws.onopen = () => {
      state.open = true;
      state.attempts = 0;
      subscribe(ws);
      logger.info(`Nostr: connected to ${url}`);
    };
    ws.onmessage = (e) => {
      const frame = parseFrame(e.data);
      if (!frame) return;
      const [type, a, b] = frame;
      if (type === 'EVENT' && b) {
        const q = pending.get(a);
        if (q) q.onEvent(b);
        else handleEvent(b);
      } else if ((type === 'EOSE' || type === 'CLOSED') && pending.has(a)) {
        pending.get(a).onEose(url);
      } else if (type === 'AUTH' && typeof a === 'string') {
        // NIP-42: inbox relays commonly serve kind 1059 only to the p-tagged key
        const auth = authEvent(url, a, privkey);
        authId = auth.id;
        ws.send(JSON.stringify(['AUTH', auth]));
      } else if (type === 'OK' && a === authId && b === true) {
        authId = null;
        subscribe(ws); // re-send anything the relay CLOSED as auth-required
      }
    };
    ws.onclose = () => {
      state.open = false;
      if (closed) return;
      const delay = Math.min(1000 * 2 ** state.attempts++, 60000);
      logger.warn(`Nostr: relay disconnected, retrying in ${delay}ms`, { relay: url });
      setTimeout(() => connectRelay(url), delay);
    };
    ws.onerror = () => { /* onclose handles retry */ };
  }

  const openConns = () => [...conns].filter(([, s]) => s.open);
  const connFor = (url) => [...conns].find(([u]) => normUrl(u) === normUrl(url))?.[1];

  /** One-shot REQ across connected relays; resolves at EOSE from all, or timeout. */
  function query(filter, timeoutMs = 3000) {
    const targets = openConns();
    if (targets.length === 0) return Promise.resolve([]);
    const subId = `jsclaw-q${++querySeq}`;
    return new Promise((resolve) => {
      const events = [];
      const waiting = new Set(targets.map(([u]) => u));
      const finish = () => {
        if (!pending.has(subId)) return;
        clearTimeout(timer);
        pending.delete(subId);
        for (const [, s] of targets) {
          try { if (s.open) s.ws.send(JSON.stringify(['CLOSE', subId])); } catch { /* closing anyway */ }
        }
        resolve(events);
      };
      const timer = setTimeout(finish, timeoutMs);
      pending.set(subId, {
        onEvent: (ev) => { if (verifyEvent(ev)) events.push(ev); },
        onEose: (u) => { waiting.delete(u); if (waiting.size === 0) finish(); },
        finish,
      });
      for (const [u, s] of targets) {
        try { s.ws.send(JSON.stringify(['REQ', subId, filter])); } catch { pending.get(subId)?.onEose(u); }
      }
    });
  }

  /** The peer's NIP-17 inbox relays (kind 10050), cached for 10 minutes. */
  async function inboxRelays(peer) {
    const cached = inboxCache.get(peer);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.relays;
    const events = await query({ kinds: [10050], authors: [peer], limit: 1 });
    const latest = events
      .filter((ev) => ev.kind === 10050 && ev.pubkey === peer && Array.isArray(ev.tags))
      .sort((x, y) => y.created_at - x.created_at)[0];
    const urls = latest
      ? [...new Set(latest.tags
        .filter((t) => t[0] === 'relay' && typeof t[1] === 'string' && /^wss?:\/\//i.test(t[1].trim()))
        .map((t) => normUrl(t[1])))].slice(0, 5)
      : [];
    inboxCache.set(peer, { relays: urls, at: Date.now() });
    return urls;
  }

  /** Publish over a short-lived connection: open, EVENT, wait for OK (or 5 s), close. */
  function publishOnce(url, event, timeoutMs = 5000) {
    return new Promise((resolve) => {
      let ws;
      let done = false;
      let authId = null;
      let resent = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws?.close(); } catch { /* already closed */ }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const send = () => ws.send(JSON.stringify(['EVENT', event]));
      try {
        ws = new WebSocket(url);
      } catch {
        finish(false);
        return;
      }
      ws.onopen = send;
      ws.onmessage = (e) => {
        const frame = parseFrame(e.data);
        if (!frame) return;
        const [type, id, ok, msg] = frame;
        if (type === 'AUTH' && typeof id === 'string') {
          const auth = authEvent(url, id, privkey);
          authId = auth.id;
          ws.send(JSON.stringify(['AUTH', auth]));
        } else if (type === 'OK' && id === authId) {
          if (ok === true && !resent) { resent = true; send(); }
          else if (ok !== true) finish(false);
        } else if (type === 'OK' && id === event.id) {
          if (ok === true) finish(true);
          else if (/^auth-required/.test(msg || '') && !resent) { /* wait for AUTH, then resend */ }
          else finish(false);
        }
      };
      ws.onerror = () => finish(false);
      ws.onclose = () => finish(false);
    });
  }

  /** Send on our live connection to url if there is one, else a one-shot connection. */
  async function publishTo(url, event) {
    const state = connFor(url);
    if (state?.open) {
      try {
        state.ws.send(JSON.stringify(['EVENT', event]));
        return true;
      } catch { /* fall through to a fresh connection */ }
    }
    return publishOnce(url, event);
  }

  async function sendNip17(recipient, text) {
    const rumor = createChatRumor(pubkey, recipient, text);
    const wrap = giftWrap(rumor, privkey, recipient);
    remember(wrap.id);

    // NIP-17: publish to the recipient's kind-10050 inbox relays. Without
    // one we fall back to our own relays, where we already met the peer.
    const inbox = await inboxRelays(recipient);
    const targets = inbox.length > 0 ? inbox : relays;
    const results = await Promise.all(targets.map((url) => publishTo(url, wrap)));
    const delivered = targets.filter((_, i) => results[i]);
    logger.info(`Nostr: NIP-17 DM to ${recipient.slice(0, 12)}… via ${inbox.length ? 'inbox' : 'own'} relays: ${delivered.join(', ') || 'none'}`);
    if (delivered.length === 0) throw new Error('no relay accepted the NIP-17 gift wrap');

    // A copy wrapped to ourselves so other clients on this key show our side
    // of the thread. Best effort: it must never fail the real send.
    try {
      const mine = giftWrap(rumor, privkey, pubkey);
      remember(mine.id);
      const frame = JSON.stringify(['EVENT', mine]);
      for (const [, s] of openConns()) {
        try { s.ws.send(frame); } catch { /* relay flake */ }
      }
    } catch (err) {
      logger.warn('Nostr: self-copy of NIP-17 DM failed', { error: err.message });
    }
  }

  return {
    name: 'nostr',
    publicKey: pubkey,
    npub: bech32Encode('npub', pubkey),

    async connect() {
      closed = false;
      for (const url of relays) connectRelay(url);
    },

    async disconnect() {
      closed = true;
      for (const q of [...pending.values()]) q.finish();
      for (const [, state] of conns) {
        try { state.ws?.close(); } catch { /* already closed */ }
        state.open = false;
      }
    },

    isConnected() {
      return [...conns.values()].some((s) => s.open);
    },

    ownsJid(jid) {
      return /^[0-9a-f]{64}$/.test(jid) || jid.startsWith('npub1');
    },

    async sendMessage(jid, text) {
      const recipient = toHex(jid, 'npub');
      if (dm === 'nip17' || (dm === 'auto' && peerProtocol.get(recipient) === 'nip17')) {
        await sendNip17(recipient, text);
        return;
      }

      const event = finalizeEvent({
        kind: 4,
        tags: [['p', recipient]],
        content: nip04Encrypt(privkey, recipient, text),
      }, privkey);

      const frame = JSON.stringify(['EVENT', event]);
      let sent = 0;
      for (const [, state] of conns) {
        if (state.open) {
          try {
            state.ws.send(frame);
            sent++;
          } catch { /* relay flake; others may succeed */ }
        }
      }
      if (sent === 0) throw new Error('no connected relays');
    },
  };
}
