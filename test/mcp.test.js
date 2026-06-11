import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMcpServers } from '../src/container-runner.js';
import { createConfig } from '../src/config.js';
import { tempConfig, nullLogger } from './helpers.js';

test('merges global and agent servers; agent wins by name', () => {
  const config = tempConfig();
  config.mcp = {
    servers: {
      github: { command: 'npx', args: ['-y', 'server-github'] },
      weather: { command: 'global-weather' },
    },
  };
  const agent = {
    name: 'g', folder: 'g',
    mcpServers: { weather: { command: 'agent-weather' } },
  };

  const resolved = resolveMcpServers(agent, config);
  assert.deepEqual(Object.keys(resolved).sort(), ['github', 'weather']);
  assert.equal(resolved.weather.command, 'agent-weather', 'agent entry overrides global');
});

test("reserved 'jsclaw' name is stripped with a warning", () => {
  const warnings = [];
  const config = tempConfig();
  config.logger = { ...nullLogger, warn: (msg) => warnings.push(msg) };
  config.mcp = { servers: { jsclaw: { command: 'evil' }, ok: { command: 'fine' } } };

  const resolved = resolveMcpServers({ name: 'g', folder: 'g' }, config);
  assert.deepEqual(Object.keys(resolved), ['ok']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reserved/);
});

test('nothing configured resolves to undefined, not an empty object', () => {
  const config = tempConfig();
  assert.equal(resolveMcpServers({ name: 'g', folder: 'g' }, config), undefined);

  config.mcp = { servers: {} };
  assert.equal(resolveMcpServers({ name: 'g', folder: 'g' }, config), undefined);

  // Only the reserved name configured → also undefined
  config.logger = { ...nullLogger };
  config.mcp = { servers: { jsclaw: { command: 'x' } } };
  assert.equal(resolveMcpServers({ name: 'g', folder: 'g' }, config), undefined);
});

test('mcp.servers in jsclaw.json gets ${ENV_VAR} expansion', () => {
  process.env.TEST_MCP_TOKEN = 'expanded-secret';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'jsclaw-mcp-'));
    const path = join(dir, 'jsclaw.json');
    writeFileSync(path, JSON.stringify({
      mcp: {
        servers: {
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${TEST_MCP_TOKEN}' },
          },
        },
      },
    }));

    const config = createConfig({ configPath: path, logger: nullLogger });
    assert.equal(
      config.mcp.servers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN,
      'expanded-secret',
      'secrets expand from the environment, never stored in the file'
    );
  } finally {
    delete process.env.TEST_MCP_TOKEN;
  }
});
