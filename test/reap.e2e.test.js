/**
 * E2E: orphan container reaping. Simulates the host crashing while
 * containers run (detached containers nobody supervises) and asserts
 * the startup reaper removes exactly the jsclaw-owned ones.
 * Skips cleanly when Docker is unavailable.
 */

import { test, after } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { reapOrphanContainers } from '../src/container-runner.js';
import { tempConfig } from './helpers.js';

let dockerAvailable = true;
try {
  execSync('docker info', { stdio: 'pipe', timeout: 15000 });
} catch {
  dockerAvailable = false;
}
const opts = { skip: !dockerAvailable && 'Docker not available' };

// Unique per-run prefix so parallel test files can't collide
const PREFIX = `jsclaw-reaptest${process.pid}-`;
const ORPHAN = `${PREFIX}orphan`;
const BYSTANDER = `keepme-reaptest${process.pid}`;

function running(name) {
  const out = execSync(`docker ps --format '{{.Names}}'`, { stdio: 'pipe' }).toString();
  return out.split('\n').includes(name);
}

after(() => {
  if (!dockerAvailable) return;
  for (const name of [ORPHAN, BYSTANDER]) {
    try { execSync(`docker rm -f ${name}`, { stdio: 'pipe' }); } catch { /* already gone */ }
  }
});

test('reaper removes orphaned jsclaw containers and spares others', opts, async () => {
  // Simulate a crash: containers running with no supervising host process
  execSync(`docker run -d --name ${ORPHAN} node:22-slim sleep 120`, { stdio: 'pipe' });
  execSync(`docker run -d --name ${BYSTANDER} node:22-slim sleep 120`, { stdio: 'pipe' });
  assert.ok(running(ORPHAN), 'orphan is running before the sweep');
  assert.ok(running(BYSTANDER), 'bystander is running before the sweep');

  const config = tempConfig();
  const reaped = await reapOrphanContainers(config, { prefix: PREFIX });

  assert.deepEqual(reaped, [ORPHAN], 'exactly the prefixed orphan reported');
  assert.ok(!running(ORPHAN), 'orphan was removed');
  assert.ok(running(BYSTANDER), 'differently-named container untouched');
});

test('reaper is a no-op when nothing matches', opts, async () => {
  const config = tempConfig();
  const reaped = await reapOrphanContainers(config, { prefix: `jsclaw-nomatch${process.pid}-` });
  assert.deepEqual(reaped, []);
});
