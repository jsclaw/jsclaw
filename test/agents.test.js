/**
 * agentId normalization (#79 Phase 0) — openclaw's slugify-on-input
 * semantics, the nostr-pubkey/npub/URI cases, and traversal closure.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeAgentId } from '../src/agents.js';
import { buildVolumeMounts } from '../src/container-runner.js';
import { tempConfig } from './helpers.js';

test('slugify-on-input: case, separators, trimming, default', () => {
  assert.equal(normalizeAgentId('main'), 'main');
  assert.equal(normalizeAgentId('  Main  '), 'main');          // trim + lower
  assert.equal(normalizeAgentId(''), 'main');                   // empty → default
  assert.equal(normalizeAgentId(null), 'main');
  assert.equal(normalizeAgentId('research bot'), 'research-bot'); // space → dash
  assert.equal(normalizeAgentId('--weird--'), 'weird');        // trim dashes
});

test('nostr identities: hex and npub pass through unchanged', () => {
  const hex = 'd769d2b81c051d2f2c0b437d0ffe39e00ff0f7161b520f0bd30811f4c057795f';
  assert.equal(normalizeAgentId(hex), hex, 'pubkey hex is already a safe slug');
  const npub = 'npub1jmqs64vt70aj64zdqjugudj5ldsvlmuxalk0jstmfms0c8xyr0rsvyuvrd';
  assert.equal(normalizeAgentId(npub), npub, 'npub bech32 passes unchanged');
});

test('URIs and DIDs are slugified (lossy, but safe)', () => {
  assert.equal(normalizeAgentId('did:nostr:abc123'), 'did-nostr-abc123');
  assert.equal(normalizeAgentId('https://example.com/me'), 'https-example-com-me');
});

test('path traversal is neutralized', () => {
  assert.equal(normalizeAgentId('../../etc/passwd'), 'etc-passwd');
  assert.equal(normalizeAgentId('..'), 'main');       // becomes empty → default
  assert.equal(normalizeAgentId('a/../../b'), 'a-b');
  assert.ok(!normalizeAgentId('../../x').includes('/'));
  assert.ok(!normalizeAgentId('../../x').includes('..'));
});

test('buildVolumeMounts cannot escape the agents dir even with a malicious folder', () => {
  const config = tempConfig();
  // runContainerAgent normalizes agent.folder; buildVolumeMounts receives it.
  // Simulate the post-normalize call the way the runner makes it:
  const safe = { name: 'x', folder: normalizeAgentId('../../../../tmp/evil') };
  const mounts = buildVolumeMounts(safe, config);
  const workspaceMount = mounts.find((m) => m.includes(':/workspace/agent'));
  assert.ok(workspaceMount.startsWith(config.agentsDir), 'mount stays under agentsDir');
  assert.ok(!workspaceMount.includes('..'), 'no traversal in the mount path');
});
