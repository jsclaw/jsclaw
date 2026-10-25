import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createHash, createCipheriv, getCiphers, randomBytes } from 'node:crypto';
import {
  getConversationKey, getMessageKeys, calcPaddedLen, encrypt, decrypt, chacha20,
} from '../src/nip44.js';
import { getPublicKey } from '../src/nostr.js';

// Official vectors: https://github.com/paulmillr/nip44 (nip44.vectors.json)
const vectors = JSON.parse(readFileSync(new URL('./fixtures/nip44.vectors.json', import.meta.url), 'utf-8')).v2;
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

test('NIP-44 valid.get_conversation_key', () => {
  for (const v of vectors.valid.get_conversation_key) {
    assert.equal(getConversationKey(v.sec1, v.pub2).toString('hex'), v.conversation_key, v.note || v.sec1);
  }
});

test('NIP-44 valid.get_message_keys', () => {
  const { conversation_key, keys } = vectors.valid.get_message_keys;
  for (const v of keys) {
    const k = getMessageKeys(conversation_key, v.nonce);
    assert.equal(k.chachaKey.toString('hex'), v.chacha_key);
    assert.equal(k.chachaNonce.toString('hex'), v.chacha_nonce);
    assert.equal(k.hmacKey.toString('hex'), v.hmac_key);
  }
});

test('NIP-44 valid.calc_padded_len', () => {
  for (const [len, padded] of vectors.valid.calc_padded_len) {
    assert.equal(calcPaddedLen(len), padded, `len ${len}`);
  }
});

test('NIP-44 valid.encrypt_decrypt', () => {
  for (const v of vectors.valid.encrypt_decrypt) {
    const key = getConversationKey(v.sec1, getPublicKey(v.sec2));
    assert.equal(key.toString('hex'), v.conversation_key);
    // Symmetric: conv(a, B) == conv(b, A)
    assert.equal(getConversationKey(v.sec2, getPublicKey(v.sec1)).toString('hex'), v.conversation_key);
    assert.equal(encrypt(v.plaintext, key, v.nonce), v.payload);
    assert.equal(decrypt(v.payload, key), v.plaintext);
  }
});

test('NIP-44 valid.encrypt_decrypt_long_msg (multi-block ChaCha20)', () => {
  for (const v of vectors.valid.encrypt_decrypt_long_msg) {
    const plaintext = v.pattern.repeat(v.repeat);
    assert.equal(sha256hex(plaintext), v.plaintext_sha256);
    const payload = encrypt(plaintext, v.conversation_key, v.nonce);
    assert.equal(sha256hex(payload), v.payload_sha256);
    assert.equal(decrypt(payload, v.conversation_key), plaintext);
  }
});

test('NIP-44 invalid.encrypt_msg_lengths throw', () => {
  const key = randomBytes(32);
  for (const len of vectors.invalid.encrypt_msg_lengths) {
    assert.throws(() => encrypt('a'.repeat(len), key), /plaintext length/, `len ${len}`);
  }
});

test('NIP-44 invalid.get_conversation_key throw', () => {
  for (const v of vectors.invalid.get_conversation_key) {
    assert.throws(() => getConversationKey(v.sec1, v.pub2), undefined, v.note);
  }
});

test('NIP-44 invalid.decrypt throw', () => {
  for (const v of vectors.invalid.decrypt) {
    assert.throws(() => decrypt(v.payload, v.conversation_key), undefined, v.note);
  }
});

test('NIP-44 invalid.decrypt messages match the failure class', () => {
  const byNote = (re) => vectors.invalid.decrypt.filter((v) => re.test(v.note));
  for (const v of byNote(/unknown encryption version/)) assert.throws(() => decrypt(v.payload, v.conversation_key), /unknown encryption version/);
  for (const v of byNote(/invalid MAC/)) assert.throws(() => decrypt(v.payload, v.conversation_key), /invalid MAC/);
  for (const v of byNote(/invalid padding/)) assert.throws(() => decrypt(v.payload, v.conversation_key), /invalid padding/);
});

test('ChaCha20 matches node:crypto (OpenSSL) across block boundaries', { skip: !getCiphers().includes('chacha20') }, () => {
  for (const len of [1, 63, 64, 65, 200, 1000, 4097]) {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const data = randomBytes(len);
    // OpenSSL's chacha20 IV = 32-bit LE counter || 96-bit nonce
    const iv = Buffer.concat([Buffer.alloc(4), nonce]);
    const c = createCipheriv('chacha20', key, iv);
    const expected = Buffer.concat([c.update(data), c.final()]);
    assert.deepEqual(chacha20(key, nonce, data), expected, `len ${len}`);
  }
});

test('NIP-44 roundtrip with random nonce; tampering is rejected', () => {
  const key = randomBytes(32);
  const msg = 'hello — čau! 🦞';
  const payload = encrypt(msg, key);
  assert.notEqual(encrypt(msg, key), payload, 'fresh nonce per message');
  assert.equal(decrypt(payload, key), msg);

  const raw = Buffer.from(payload, 'base64');
  raw[40] ^= 1;
  assert.throws(() => decrypt(raw.toString('base64'), key), /invalid MAC/);
  assert.throws(() => decrypt(payload, randomBytes(32)), /invalid MAC/);
});
