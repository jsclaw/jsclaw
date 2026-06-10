import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, loadConfigFile } from '../src/config.js';
import { nullLogger } from './helpers.js';

function tempFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'jsclaw-cfg-'));
  const path = join(dir, 'jsclaw.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

test('defaults are sane', () => {
  const c = createConfig({ configPath: '/nonexistent/jsclaw.json', logger: nullLogger });
  assert.equal(c.containerRuntime, 'docker');
  assert.equal(c.containerImage, 'jsclaw-agent:latest');
  assert.equal(c.maxConcurrentContainers, 5);
  assert.equal(c.heartbeatInterval, 30 * 60 * 1000);
  assert.ok(c.skillsDir.endsWith('skills'));
});

test('config file values override defaults', () => {
  const path = tempFile({ containerImage: 'custom:v1', maxConcurrentContainers: 9 });
  const c = createConfig({ configPath: path, logger: nullLogger });
  assert.equal(c.containerImage, 'custom:v1');
  assert.equal(c.maxConcurrentContainers, 9);
  assert.equal(c.containerRuntime, 'docker'); // untouched default
});

test('${ENV_VAR} expansion in config file strings', () => {
  process.env.TEST_JSCLAW_IMAGE = 'expanded:latest';
  try {
    const path = tempFile({ containerImage: '${TEST_JSCLAW_IMAGE}' });
    const c = createConfig({ configPath: path, logger: nullLogger });
    assert.equal(c.containerImage, 'expanded:latest');
  } finally {
    delete process.env.TEST_JSCLAW_IMAGE;
  }
});

test('env vars beat the config file; overrides beat env vars', () => {
  process.env.JSCLAW_CONTAINER_IMAGE = 'from-env:1';
  try {
    const path = tempFile({ containerImage: 'from-file:1' });
    const viaEnv = createConfig({ configPath: path, logger: nullLogger });
    assert.equal(viaEnv.containerImage, 'from-env:1');

    const viaOverride = createConfig({
      configPath: path, containerImage: 'from-override:1', logger: nullLogger,
    });
    assert.equal(viaOverride.containerImage, 'from-override:1');
  } finally {
    delete process.env.JSCLAW_CONTAINER_IMAGE;
  }
});

test('explicit config path that is malformed throws; missing default path does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsclaw-cfg-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.throws(() => loadConfigFile(bad), /Failed to load config file/);

  // No file at the default location is fine
  const c = createConfig({ configPath: join(dir, 'absent.json'), logger: nullLogger });
  assert.ok(c.containerImage);
});
