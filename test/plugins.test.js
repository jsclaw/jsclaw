/**
 * Plugin loader tests — manifest loading, openclaw policy semantics
 * (deny > allow > entry.enabled), per-plugin config delivery, failure
 * degradation, and end-to-end registration through gateway + commands.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadPlugins } from '../src/plugins.js';
import { registerPluginCommands, _clearPluginCommands, handleCommand, listCommands } from '../src/commands.js';
import { tempConfig, nullLogger } from './helpers.js';

let counter = 0;
function writePlugin(root, id, body) {
  const dir = join(root, `${id}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'jsclaw.plugin.json'), JSON.stringify({ id, version: '1.0.0', entry: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), body);
  return dir;
}

const DEMO = `export function activate(api) {
  api.registerChannel('demo', () => ({ name: 'demo' }));
  api.registerCommand({ key: 'ping', textAliases: ['/ping'], description: 'pong' }, async (args) => ({ reply: 'pong ' + (api.config.suffix || '') }));
  api.registerGatewayMethod('demo.hello', (params) => ({ hello: params?.name || 'world' }));
  api.registerMcpTool('demo_tool', { description: 'd', handler: async () => 'demo result' });
}`;

test('loads a plugin and collects all four registration kinds', async () => {
  const config = tempConfig();
  const dir = writePlugin(config.dataDir, 'demo', DEMO);
  config.plugins = { load: { paths: [dir] }, entries: { demo: { config: { suffix: 'from-config' } } } };

  const { registrations, plugins } = await loadPlugins(config, { logger: nullLogger });
  assert.equal(plugins[0].id, 'demo');
  assert.ok(registrations.channels.demo);
  assert.equal(registrations.commands[0].key, 'ping');
  assert.equal(registrations.commands[0].source, 'plugin:demo');
  assert.deepEqual(registrations.gatewayMethods['demo.hello']({ name: 'x' }), { hello: 'x' });
  assert.ok(registrations.mcpTools.demo_tool);

  // per-plugin config reached the handler
  const out = await registrations.commands[0].handler('');
  assert.equal(out.reply, 'pong from-config');
});

test('policy: deny beats allow beats entry.enabled; broken plugins degrade', async () => {
  const config = tempConfig();
  const a = writePlugin(config.dataDir, 'aaa', DEMO);
  const b = writePlugin(config.dataDir, 'bbb', DEMO);
  const c = writePlugin(config.dataDir, 'ccc', DEMO);
  const broken = writePlugin(config.dataDir, 'broken', 'export const nope = 1;'); // no activate
  const warnings = [];
  const logger = { ...nullLogger, warn: (m) => warnings.push(m) };

  config.plugins = {
    load: { paths: [a, b, c, broken, join(config.dataDir, 'missing')] },
    allow: ['aaa', 'bbb', 'broken'],
    deny: ['bbb'],
    entries: { aaa: { enabled: true } },
  };
  const { plugins } = await loadPlugins(config, { logger });
  assert.deepEqual(plugins.map((p) => p.id), ['aaa']); // bbb denied, ccc not allowed, broken failed, missing failed
  assert.ok(warnings.some((w) => /denied/.test(w)));
  assert.ok(warnings.some((w) => /must export activate/.test(w)));

  // disabled entirely
  config.plugins = { enabled: false, load: { paths: [a] } };
  const off = await loadPlugins(config, { logger });
  assert.equal(off.plugins.length, 0);
});

test('plugin commands run host-side and appear in listCommands', async (t) => {
  t.after(() => _clearPluginCommands());
  const config = tempConfig();
  const dir = writePlugin(config.dataDir, 'demo', DEMO);
  config.plugins = { load: { paths: [dir] } };
  const { registrations } = await loadPlugins(config, { logger: nullLogger });
  registerPluginCommands(registrations.commands);

  const handled = await handleCommand('/ping', { config, agentId: 'main' });
  assert.equal(handled.reply, 'pong ');

  const listed = listCommands(config).find((c) => c.name === '/ping');
  assert.equal(listed.source, 'plugin:demo');
});
