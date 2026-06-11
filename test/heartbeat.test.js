import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startHeartbeat, inQuietHours, HEARTBEAT_OK } from '../src/heartbeat.js';
import { tempConfig } from './helpers.js';

function setupAgent(config, folder, heartbeatContent) {
  const dir = join(config.agentsDir, folder);
  mkdirSync(dir, { recursive: true });
  if (heartbeatContent !== undefined) {
    writeFileSync(join(dir, 'HEARTBEAT.md'), heartbeatContent);
  }
}

test('HEARTBEAT_OK responses are suppressed, alerts delivered', async () => {
  const config = tempConfig({ heartbeatInterval: 1e9 });
  setupAgent(config, 'hb', '- check the thing');

  const alerts = [];
  let response = HEARTBEAT_OK;
  const hb = startHeartbeat({
    getAgents: () => [{ name: 'hb', folder: 'hb' }],
    runAgent: async () => ({ status: 'success', result: response }),
    onAlert: async (agent, result) => alerts.push(result),
  }, config);

  await hb.triggerNow();
  assert.equal(alerts.length, 0);

  response = `${HEARTBEAT_OK} — all quiet`;  // prefixed OK also suppressed
  await hb.triggerNow();
  assert.equal(alerts.length, 0);

  response = 'Deploy failed!';
  await hb.triggerNow();
  assert.deepEqual(alerts, ['Deploy failed!']);
  hb.stop();
});

test('agents without HEARTBEAT.md are skipped', async () => {
  const config = tempConfig({ heartbeatInterval: 1e9 });
  setupAgent(config, 'no-file');
  setupAgent(config, 'empty', '   \n');

  let calls = 0;
  const hb = startHeartbeat({
    getAgents: () => [{ name: 'no-file', folder: 'no-file' }, { name: 'empty', folder: 'empty' }],
    runAgent: async () => { calls++; return { status: 'success', result: HEARTBEAT_OK }; },
  }, config);

  await hb.triggerNow();
  assert.equal(calls, 0);
  hb.stop();
});

test('heartbeat prompt includes the HEARTBEAT.md tasks', async () => {
  const config = tempConfig({ heartbeatInterval: 1e9 });
  setupAgent(config, 'hb', '- watch the deploys');

  let seenPrompt = '';
  const hb = startHeartbeat({
    getAgents: () => [{ name: 'hb', folder: 'hb' }],
    runAgent: async (agent, prompt) => { seenPrompt = prompt; return { result: HEARTBEAT_OK }; },
  }, config);

  await hb.triggerNow();
  assert.ok(seenPrompt.includes('[HEARTBEAT]'));
  assert.ok(seenPrompt.includes('watch the deploys'));
  assert.ok(seenPrompt.includes(HEARTBEAT_OK));
  hb.stop();
});

test('agent errors do not break the loop', async () => {
  const config = tempConfig({ heartbeatInterval: 1e9 });
  setupAgent(config, 'hb', '- task');

  const hb = startHeartbeat({
    getAgents: () => [{ name: 'hb', folder: 'hb' }],
    runAgent: async () => { throw new Error('container exploded'); },
  }, config);

  await assert.doesNotReject(hb.triggerNow());
  hb.stop();
});

test('inQuietHours handles same-day and midnight-crossing windows', () => {
  const at = (h, m = 0) => new Date(2026, 5, 9, h, m);
  // Same-day window
  assert.ok(inQuietHours({ start: '09:00', end: '17:00' }, at(12)));
  assert.ok(!inQuietHours({ start: '09:00', end: '17:00' }, at(18)));
  // Midnight crossing
  const night = { start: '22:00', end: '07:00' };
  assert.ok(inQuietHours(night, at(23, 30)));
  assert.ok(inQuietHours(night, at(3)));
  assert.ok(!inQuietHours(night, at(12)));
  // Boundaries: start inclusive, end exclusive
  assert.ok(inQuietHours(night, at(22, 0)));
  assert.ok(!inQuietHours(night, at(7, 0)));
  // Unset
  assert.ok(!inQuietHours(undefined, at(3)));
});

test('triggerNow bypasses quiet hours', async () => {
  const config = tempConfig({ heartbeatInterval: 1e9 });
  setupAgent(config, 'hb', '- task');

  let calls = 0;
  const hb = startHeartbeat({
    getAgents: () => [{ name: 'hb', folder: 'hb' }],
    runAgent: async () => { calls++; return { result: HEARTBEAT_OK }; },
  }, config, { quietHours: { start: '00:00', end: '23:59' } });

  await hb.triggerNow();
  assert.equal(calls, 1);
  hb.stop();
});
