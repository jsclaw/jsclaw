/**
 * Nostr channel — decentralized encrypted DMs for jsclaw agents.
 * Zero dependencies: secp256k1 in pure BigInt (affine — auditable over
 * fast; DM volume doesn't need Jacobian), BIP340 Schnorr via tagged
 * SHA-256, NIP-04 encryption via node:crypto, relays via Node's native
 * WebSocket client.
 *
 * Talk to your containerized agent from any Nostr client. No bot
 * tokens, no platform accounts, no central server.
 * @module nostr
 */

import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createLogger } from './logger.js';

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

// --- the channel ---

/**
 * Create a jsclaw Channel over Nostr encrypted DMs (kind 4 / NIP-04).
 *
 * Authorization is default-closed: only pubkeys in allowedPubkeys reach
 * onMessage, unless open: true is set explicitly.
 *
 * @param {Object} options
 * @param {string} options.privateKey - Agent's key (hex or nsec)
 * @param {string[]} options.relays - Relay websocket URLs
 * @param {(jid: string, text: string, event: Object) => void} options.onMessage - Inbound DM (jid = sender pubkey hex)
 * @param {string[]} [options.allowedPubkeys] - Senders allowed to reach the agent (hex or npub)
 * @param {boolean} [options.open] - Accept DMs from anyone (explicit opt-in)
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
    logger = createLogger(),
  } = options;

  if (!privateKey) throw new Error('createNostrChannel requires a privateKey');
  if (relays.length === 0) throw new Error('createNostrChannel requires at least one relay');
  if (typeof onMessage !== 'function') throw new Error('createNostrChannel requires onMessage');

  const privkey = toHex(privateKey, 'nsec');
  const pubkey = getPublicKey(privkey);
  const allowed = new Set(allowedPubkeys.map((k) => toHex(k, 'npub')));

  /** @type {Map<string, { ws: WebSocket|null, open: boolean, attempts: number }>} */
  const conns = new Map(relays.map((url) => [url, { ws: null, open: false, attempts: 0 }]));
  const seen = new Set();
  let closed = false;
  const sinceConnect = Math.floor(Date.now() / 1000) - 10;

  function handleEvent(event) {
    if (event.kind !== 4 || event.pubkey === pubkey) return;
    if (seen.has(event.id)) return;
    seen.add(event.id);
    if (seen.size > 5000) {
      // Drop the oldest half; ids re-arriving later are harmless dupes
      const ids = [...seen];
      for (const id of ids.slice(0, 2500)) seen.delete(id);
    }

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
    onMessage(event.pubkey, text, event);
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

    ws.onopen = () => {
      state.open = true;
      state.attempts = 0;
      ws.send(JSON.stringify(['REQ', 'jsclaw-dm', { kinds: [4], '#p': [pubkey], since: sinceConnect }]));
      logger.info(`Nostr: connected to ${url}`);
    };
    ws.onmessage = (e) => {
      let frame;
      try {
        frame = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
      } catch {
        return;
      }
      if (Array.isArray(frame) && frame[0] === 'EVENT' && frame[2]) handleEvent(frame[2]);
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
