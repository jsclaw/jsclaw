/**
 * Session store tests — openclaw's session model (#57): resolve,
 * advance, reset (fresh conversation, same key), patch (label/model),
 * list, and persistence across store instances (gateway restarts).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { SessionStore } from '../src/sessions.js';
import { tempConfig } from './helpers.js';

test('resolve creates once, advance threads the runner sessionId', () => {
  const config = tempConfig();
  const store = new SessionStore(config);

  const row = store.resolve('telegram:42', 'main');
  assert.equal(row.agentId, 'main');
  assert.equal(row.sessionId, undefined);

  store.advance('telegram:42', 's-abc');
  assert.equal(store.resolve('telegram:42').sessionId, 's-abc');
});

test('reset starts a fresh conversation under the same key', () => {
  const store = new SessionStore(tempConfig());
  store.advance('main', 's-1');
  const result = store.reset('main', 'new');
  assert.deepEqual(result, { ok: true, key: 'main', reason: 'new' });
  assert.equal(store.resolve('main').sessionId, undefined);
});

test('patch sets and clears label/model, openclaw null-clears', () => {
  const store = new SessionStore(tempConfig());
  const row = store.patch('main', { label: 'research', model: 'glm-4.5-air' });
  assert.equal(row.label, 'research');
  assert.equal(row.model, 'glm-4.5-air');

  const cleared = store.patch('main', { label: null });
  assert.equal(cleared.label, undefined);
  assert.equal(cleared.model, 'glm-4.5-air', 'untouched fields persist');
});

test('list sorts by recency and filters by agent', async () => {
  const store = new SessionStore(tempConfig());
  store.resolve('a', 'main');
  await new Promise((r) => setTimeout(r, 5));
  store.resolve('b', 'research');
  await new Promise((r) => setTimeout(r, 5));
  store.advance('a', 's-1'); // touch a — most recent again

  const all = store.list();
  assert.deepEqual(all.sessions.map((s) => s.key), ['a', 'b']);
  assert.deepEqual(store.list({ agentId: 'research' }).sessions.map((s) => s.key), ['b']);
});

test('sessions survive a store restart (gateway restart)', () => {
  const config = tempConfig();
  const first = new SessionStore(config);
  first.advance('nostr:npub1xyz', 's-99');
  first.patch('nostr:npub1xyz', { model: 'glm-4.6' });

  const reborn = new SessionStore(config);
  const row = reborn.resolve('nostr:npub1xyz');
  assert.equal(row.sessionId, 's-99');
  assert.equal(row.model, 'glm-4.6');
});

// --- host-owned transcripts (#79 / B) ---

test('saveMessages mints a sessionId, writes under data/sessions, loadMessages reads it back', () => {
  const config = tempConfig();
  const store = new SessionStore(config);

  assert.deepEqual(store.loadMessages('telegram:42'), [], 'empty before any save');
  store.saveMessages('telegram:42', [{ role: 'user', content: 'hi' }], 'main');
  const row = store.resolve('telegram:42');
  assert.ok(row.sessionId, 'sessionId minted by host on first save');
  assert.match(store.transcriptPath(row), /data\/sessions\/main\/.*\.json$/);
  assert.deepEqual(store.loadMessages('telegram:42'), [{ role: 'user', content: 'hi' }]);

  // append a turn — same sessionId, updated transcript
  const before = row.sessionId;
  store.saveMessages('telegram:42', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  assert.equal(store.resolve('telegram:42').sessionId, before);
  assert.equal(store.loadMessages('telegram:42').length, 2);
});

test('reset deletes the transcript so the next turn starts empty', () => {
  const config = tempConfig();
  const store = new SessionStore(config);
  store.saveMessages('main', [{ role: 'user', content: 'remember X' }], 'main');
  assert.equal(store.loadMessages('main').length, 1);

  store.reset('main', 'new');
  assert.deepEqual(store.loadMessages('main'), [], 'transcript gone after reset');
  assert.equal(store.resolve('main').sessionId, undefined);

  // survives a restart as empty
  assert.deepEqual(new SessionStore(config).loadMessages('main'), []);
});
