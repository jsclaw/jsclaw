/**
 * NIP-44 v2 encrypted payloads — zero dependencies.
 *
 * secp256k1 ECDH (unhashed shared x) → HKDF-SHA256 → ChaCha20 (pure JS,
 * RFC 8439 block function, counter from 0, no Poly1305) → HMAC-SHA256
 * over nonce || ciphertext → base64(0x02 || nonce || ciphertext || mac).
 *
 * Plaintext is 1..65535 bytes with the 2-byte length prefix, matching the
 * official test vectors and every deployed client.
 * Spec: https://github.com/nostr-protocol/nips/blob/master/44.md
 * @module nip44
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sharedSecretX } from './nostr.js';

const VERSION = 2;
const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 65535;
const SALT = Buffer.from('nip44-v2', 'utf-8');

const hmac = (key, ...data) => {
  const h = createHmac('sha256', key);
  for (const d of data) h.update(d);
  return h.digest();
};

const toBuf = (x, name, len) => {
  const b = typeof x === 'string' ? Buffer.from(x, 'hex') : Buffer.from(x);
  if (len != null && b.length !== len) throw new Error(`invalid ${name} length`);
  return b;
};

// --- HKDF (RFC 5869), extract and expand kept separate as NIP-44 needs ---

const hkdfExtract = (salt, ikm) => hmac(salt, ikm);

function hkdfExpand(prk, info, length) {
  const blocks = [];
  let prev = Buffer.alloc(0);
  for (let i = 1; blocks.length * 32 < length; i++) {
    prev = hmac(prk, prev, info, Buffer.from([i]));
    blocks.push(prev);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

// --- ChaCha20 (RFC 8439) ---

const rotl = (x, n) => (x << n) | (x >>> (32 - n));

function quarterRound(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) | 0; s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) | 0; s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) | 0; s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) | 0; s[b] = rotl(s[b] ^ s[c], 7);
}

/**
 * ChaCha20 stream cipher (IETF: 32-byte key, 12-byte nonce, 32-bit block
 * counter). XORs the keystream into data; encrypt and decrypt are the same.
 * @param {Buffer} key - 32 bytes
 * @param {Buffer} nonce - 12 bytes
 * @param {Buffer} data
 * @param {number} [counter=0]
 * @returns {Buffer}
 */
export function chacha20(key, nonce, data, counter = 0) {
  if (key.length !== 32) throw new Error('chacha20 key must be 32 bytes');
  if (nonce.length !== 12) throw new Error('chacha20 nonce must be 12 bytes');
  const init = new Uint32Array(16);
  init[0] = 0x61707865; init[1] = 0x3320646e; init[2] = 0x79622d32; init[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) init[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 3; i++) init[13 + i] = nonce.readUInt32LE(i * 4);

  const out = Buffer.alloc(data.length);
  const state = new Uint32Array(16);
  const block = Buffer.alloc(64);
  for (let pos = 0; pos < data.length; pos += 64) {
    init[12] = counter++;
    state.set(init);
    for (let r = 0; r < 10; r++) {
      quarterRound(state, 0, 4, 8, 12); quarterRound(state, 1, 5, 9, 13);
      quarterRound(state, 2, 6, 10, 14); quarterRound(state, 3, 7, 11, 15);
      quarterRound(state, 0, 5, 10, 15); quarterRound(state, 1, 6, 11, 12);
      quarterRound(state, 2, 7, 8, 13); quarterRound(state, 3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) block.writeUInt32LE((state[i] + init[i]) >>> 0, i * 4);
    const n = Math.min(64, data.length - pos);
    for (let i = 0; i < n; i++) out[pos + i] = data[pos + i] ^ block[i];
  }
  return out;
}

// --- NIP-44 v2 ---

/**
 * Long-term key between two users: conv(a, B) == conv(b, A).
 * @param {string} privkeyHex
 * @param {string} pubkeyHex - x-only
 * @returns {Buffer} 32 bytes
 */
export function getConversationKey(privkeyHex, pubkeyHex) {
  return hkdfExtract(SALT, sharedSecretX(privkeyHex, pubkeyHex));
}

/**
 * Per-message keys from the conversation key and a 32-byte nonce.
 * @param {Buffer|string} conversationKey
 * @param {Buffer|string} nonce
 * @returns {{ chachaKey: Buffer, chachaNonce: Buffer, hmacKey: Buffer }}
 */
export function getMessageKeys(conversationKey, nonce) {
  const keys = hkdfExpand(toBuf(conversationKey, 'conversation_key', 32), toBuf(nonce, 'nonce', 32), 76);
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  };
}

/**
 * Padded length for an unpadded plaintext length (power-of-two chunks,
 * 32-byte minimum).
 * @param {number} len
 */
export function calcPaddedLen(len) {
  if (!Number.isInteger(len) || len < 1) throw new Error('expected positive integer');
  if (len <= 32) return 32;
  const nextPower = 2 ** (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function pad(plaintext) {
  const unpadded = Buffer.from(plaintext, 'utf-8');
  const len = unpadded.length;
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT) throw new Error('invalid plaintext length: must be between 1 and 65535 bytes');
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(len);
  return Buffer.concat([prefix, unpadded, Buffer.alloc(calcPaddedLen(len) - len)]);
}

function unpad(padded) {
  const len = padded.readUInt16BE(0);
  const unpadded = padded.subarray(2, 2 + len);
  if (len === 0 || unpadded.length !== len || padded.length !== 2 + calcPaddedLen(len)) {
    throw new Error('invalid padding');
  }
  return unpadded.toString('utf-8');
}

const hmacAad = (key, message, aad) => {
  if (aad.length !== 32) throw new Error('AAD associated data must be 32 bytes');
  return hmac(key, aad, message);
};

/**
 * Encrypt a string to a NIP-44 v2 payload.
 * @param {string} plaintext
 * @param {Buffer|string} conversationKey - from getConversationKey()
 * @param {Buffer|string} [nonce] - 32 bytes; random by default (tests pass a fixed one)
 * @returns {string} base64 payload
 */
export function encrypt(plaintext, conversationKey, nonce = randomBytes(32)) {
  nonce = toBuf(nonce, 'nonce', 32);
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext));
  const mac = hmacAad(hmacKey, ciphertext, nonce);
  return Buffer.concat([Buffer.from([VERSION]), nonce, ciphertext, mac]).toString('base64');
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodePayload(payload) {
  if (typeof payload !== 'string') throw new Error('payload must be a string');
  const plen = payload.length;
  if (plen === 0 || payload[0] === '#') throw new Error('unknown encryption version');
  // 132..87472 base64 chars ↔ 99..65603 raw bytes (2-byte prefix range)
  if (plen < 132 || plen > 87472) throw new Error('invalid payload size');
  if (plen % 4 !== 0 || !BASE64_RE.test(payload)) throw new Error('invalid base64');
  const data = Buffer.from(payload, 'base64');
  const dlen = data.length;
  if (dlen < 99 || dlen > 65603) throw new Error('invalid data size');
  if (data[0] !== VERSION) throw new Error(`unknown encryption version ${data[0]}`);
  return {
    nonce: data.subarray(1, 33),
    ciphertext: data.subarray(33, dlen - 32),
    mac: data.subarray(dlen - 32),
  };
}

/**
 * Decrypt a NIP-44 v2 payload.
 * @param {string} payload - base64
 * @param {Buffer|string} conversationKey
 * @returns {string} plaintext
 * @throws {Error} on unknown version, malformed payload, bad MAC or bad padding
 */
export function decrypt(payload, conversationKey) {
  const { nonce, ciphertext, mac } = decodePayload(payload);
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const expected = hmacAad(hmacKey, ciphertext, nonce);
  if (!timingSafeEqual(expected, mac)) throw new Error('invalid MAC');
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}
