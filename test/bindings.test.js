import { test } from 'node:test';
import assert from 'node:assert';
import { resolveBinding, resolveAgentConfig } from '../src/bindings.js';

const BINDINGS = [
  { match: { channel: 'telegram', peer: 'boss-id' }, agentId: 'researcher' },
  { match: { channel: 'telegram' }, agentId: 'assistant' },
  { match: { channel: 'discord' }, agentId: 'coder' },
  { match: { channel: 'telegram', peer: 'boss-id', accountId: 'work' }, agentId: 'work-researcher' },
];

test('most specific binding wins', () => {
  assert.equal(
    resolveBinding(BINDINGS, { channel: 'telegram', peer: 'boss-id', accountId: 'work' }),
    'work-researcher'
  );
  assert.equal(
    resolveBinding(BINDINGS, { channel: 'telegram', peer: 'boss-id' }),
    'researcher'
  );
  assert.equal(
    resolveBinding(BINDINGS, { channel: 'telegram', peer: 'someone-else' }),
    'assistant'
  );
  assert.equal(resolveBinding(BINDINGS, { channel: 'discord', peer: 'x' }), 'coder');
});

test('unmatched messages fall through to the default agent', () => {
  assert.equal(resolveBinding(BINDINGS, { channel: 'slack' }), 'main');
  assert.equal(resolveBinding(BINDINGS, { channel: 'slack' }, 'fallback'), 'fallback');
  assert.equal(resolveBinding([], { channel: 'telegram' }), 'main');
  assert.equal(resolveBinding(undefined, { channel: 'telegram' }), 'main');
});

test('ties break by list order, deterministically', () => {
  const bindings = [
    { match: { channel: 'telegram' }, agentId: 'first' },
    { match: { peer: 'p1' }, agentId: 'second' },
  ];
  // Both match with specificity 1 — first in list wins
  assert.equal(resolveBinding(bindings, { channel: 'telegram', peer: 'p1' }), 'first');
  // Same input always same output
  for (let i = 0; i < 5; i++) {
    assert.equal(resolveBinding(bindings, { channel: 'telegram', peer: 'p1' }), 'first');
  }
});

test('bindings with empty match are ignored', () => {
  const bindings = [{ match: {}, agentId: 'greedy' }];
  assert.equal(resolveBinding(bindings, { channel: 'telegram' }), 'main');
});

test('resolveAgentConfig merges defaults with list entry', () => {
  const agents = {
    defaults: { model: 'claude-haiku-4-5-20251001', heartbeat: { every: '30m' } },
    list: [
      { id: 'researcher', model: 'claude-opus-4-8', folder: 'research' },
      { id: 'monitor' },
    ],
  };

  const researcher = resolveAgentConfig(agents, 'researcher');
  assert.equal(researcher.model, 'claude-opus-4-8'); // entry overrides default
  assert.equal(researcher.folder, 'research');

  const monitor = resolveAgentConfig(agents, 'monitor');
  assert.equal(monitor.model, 'claude-haiku-4-5-20251001'); // inherits default
  assert.equal(monitor.folder, 'monitor'); // folder defaults to id

  // Unknown agent still resolves sanely
  const unknown = resolveAgentConfig(agents, 'mystery');
  assert.equal(unknown.id, 'mystery');
  assert.equal(unknown.folder, 'mystery');

  // No agents config at all
  const bare = resolveAgentConfig(undefined, 'main');
  assert.equal(bare.folder, 'main');
});
