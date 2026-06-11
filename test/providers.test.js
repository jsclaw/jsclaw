import { test } from 'node:test';
import assert from 'node:assert';
import { PROVIDERS, PROVIDER_ENV_KEYS, resolveProviderEnv } from '../src/providers.js';
import { buildContainerArgs } from '../src/container-runner.js';
import { buildOnboardConfig, mergeConfigFile, scaffoldGroup } from '../bin/onboard.js';
import { tempConfig } from './helpers.js';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Snapshot + clear provider env so host vars can't bleed into tests. */
function withCleanEnv(fn) {
  const saved = {};
  for (const key of PROVIDER_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('presets are well-formed; GLM and Kimi are first-class', () => {
  for (const [name, preset] of Object.entries(PROVIDERS)) {
    assert.ok(preset.label, `${name} has a label`);
    assert.ok(preset.keyEnv, `${name} names its key env var`);
  }
  assert.ok(PROVIDERS.zai.baseUrl.includes('z.ai'));
  assert.equal(PROVIDERS.zai.keyStyle, 'authToken');
  assert.ok(PROVIDERS.moonshot.baseUrl.includes('moonshot'));
  assert.ok(PROVIDERS.bedrock.env.CLAUDE_CODE_USE_BEDROCK);
});

test('resolveProviderEnv: whitelist only, config beats host env', () => {
  withCleanEnv(() => {
    const config = tempConfig();
    assert.equal(resolveProviderEnv(config), undefined, 'empty env → undefined');

    process.env.ANTHROPIC_API_KEY = 'host-key';
    process.env.ANTHROPIC_BASE_URL = 'https://host-url';
    process.env.TOTALLY_UNRELATED_SECRET = 'must-not-pass';

    let env = resolveProviderEnv(config);
    assert.equal(env.ANTHROPIC_API_KEY, 'host-key');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://host-url');
    assert.ok(!('TOTALLY_UNRELATED_SECRET' in env), 'non-whitelisted vars stay on the host');

    config.providerBaseUrl = 'https://api.z.ai/api/anthropic';
    config.providerAuthToken = 'glm-token';
    env = resolveProviderEnv(config);
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic', 'config wins over host env');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'glm-token');

    delete process.env.TOTALLY_UNRELATED_SECRET;
  });
});

test('credentials never appear in docker argv', () => {
  withCleanEnv(() => {
    process.env.ANTHROPIC_API_KEY = 'super-secret';
    const config = tempConfig();
    const args = buildContainerArgs(['-v', '/x:/y'], 'jsclaw-test-1', config, {
      JSCLAW_CHAT_JID: 'jid',
    });
    const joined = args.join(' ');
    assert.ok(!joined.includes('super-secret'), 'API key not in argv');
    assert.ok(!joined.includes('ANTHROPIC'), 'no provider env via -e flags at all');
  });
});

// --- onboarding logic ---

test('buildOnboardConfig: anthropic uses host env, no token in config', () => {
  const { config, envExports } = buildOnboardConfig({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    heartbeatModel: 'claude-haiku-4-5-20251001',
    gatewayToken: 'tok',
  });
  assert.equal(config.model, 'claude-sonnet-4-6');
  assert.equal(config.heartbeatModel, 'claude-haiku-4-5-20251001');
  assert.equal(config.gatewayToken, 'tok');
  assert.ok(!config.providerBaseUrl && !config.providerAuthToken);
  assert.ok(envExports.some((l) => l.includes('ANTHROPIC_API_KEY')));
});

test('buildOnboardConfig: GLM writes baseUrl + ${ENV} reference, never a literal', () => {
  const { config, envExports } = buildOnboardConfig({
    provider: 'zai', model: 'glm-4.6', heartbeatModel: 'glm-4.5-air',
  });
  assert.equal(config.providerBaseUrl, 'https://api.z.ai/api/anthropic');
  assert.equal(config.providerAuthToken, '${ZAI_API_KEY}');
  assert.ok(envExports.some((l) => l.startsWith('export ZAI_API_KEY=')));
});

test('buildOnboardConfig: Kimi, Bedrock, custom endpoint', () => {
  const kimi = buildOnboardConfig({ provider: 'moonshot', model: 'kimi-k2-0905-preview' });
  assert.equal(kimi.config.providerAuthToken, '${MOONSHOT_API_KEY}');
  assert.ok(kimi.config.providerBaseUrl.includes('moonshot'));

  const bedrock = buildOnboardConfig({ provider: 'bedrock' });
  assert.ok(!bedrock.config.providerBaseUrl);
  assert.ok(bedrock.envExports.some((l) => l.includes('CLAUDE_CODE_USE_BEDROCK=1')));
  assert.ok(bedrock.envExports.some((l) => l.includes('AWS_REGION')));

  const custom = buildOnboardConfig({
    provider: 'custom', baseUrl: 'http://localhost:4000', keyEnvVar: 'LITELLM_KEY',
  });
  assert.equal(custom.config.providerBaseUrl, 'http://localhost:4000');
  assert.equal(custom.config.providerAuthToken, '${LITELLM_KEY}');

  assert.throws(() => buildOnboardConfig({ provider: 'nope' }), /unknown provider/);
});

test('mergeConfigFile preserves unrelated keys and raw ${ENV} refs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsclaw-onboard-'));
  const path = join(dir, 'jsclaw.json');
  writeFileSync(path, JSON.stringify({
    maxConcurrentContainers: 8,
    providerAuthToken: '${OLD_KEY}',
  }));

  const merged = mergeConfigFile(path, { model: 'glm-4.6', providerAuthToken: '${NEW_KEY}' });
  assert.equal(merged.maxConcurrentContainers, 8, 'unrelated key preserved');
  assert.equal(merged.model, 'glm-4.6');

  const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
  assert.equal(onDisk.providerAuthToken, '${NEW_KEY}', 'reference stored raw, not expanded');
});

test('scaffoldGroup is idempotent and seeds identity + memory', () => {
  const config = tempConfig();
  const created = scaffoldGroup('main', config);
  assert.deepEqual(created.sort(), ['HEARTBEAT.md', 'SOUL.md']);
  assert.ok(existsSync(join(config.groupsDir, 'main', 'memory', 'preferences.md')));

  // Second run must not clobber
  writeFileSync(join(config.groupsDir, 'main', 'SOUL.md'), 'customized');
  const again = scaffoldGroup('main', config);
  assert.deepEqual(again, []);
  assert.equal(readFileSync(join(config.groupsDir, 'main', 'SOUL.md'), 'utf-8'), 'customized');
});
