/**
 * Tests for containerRuntime 'local' — agents as plain child processes.
 * Uses the local mock runner fixture; no Docker, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runContainerAgent, reapOrphanContainers, resolveSandbox, _resetEngineChecks } from '../src/container-runner.js';
import { tempConfig } from './helpers.js';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'local-mock-runner.js');

function localConfig(overrides = {}) {
  return tempConfig({ sandboxMode: 'off', localRunner: RUNNER, ...overrides });
}

const AGENT = { name: 'main', folder: 'main' };
const INPUT = { prompt: 'hello', agentId: 'main', chatJid: 'test', isMain: true };

test('resolveSandbox honors mode, isMain, per-agent override, and auto fallback', async () => {
  const cfg = (mode, extra = {}) => tempConfig({ sandboxMode: mode, ...extra });

  assert.equal(await resolveSandbox(AGENT, INPUT, cfg('off')), false);
  assert.equal(await resolveSandbox(AGENT, INPUT, cfg('all')), true);
  assert.equal(await resolveSandbox(AGENT, { ...INPUT, isMain: true }, cfg('non-main')), false);
  assert.equal(await resolveSandbox(AGENT, { ...INPUT, isMain: false }, cfg('non-main')), true);

  // Per-agent override beats the global mode
  assert.equal(await resolveSandbox({ ...AGENT, sandbox: true }, INPUT, cfg('off')), true);
  assert.equal(await resolveSandbox({ ...AGENT, sandbox: false }, INPUT, cfg('all')), false);

  // auto falls back to local when the engine is missing
  _resetEngineChecks();
  assert.equal(await resolveSandbox(AGENT, INPUT, cfg('auto', { containerRuntime: 'no-such-engine-xyz' })), false);
  _resetEngineChecks();

  // the pre-#42 'local' runtime value gets a migration error
  await assert.rejects(
    () => resolveSandbox(AGENT, INPUT, tempConfig({ containerRuntime: 'local' })),
    /replaced by sandboxMode/
  );

  await assert.rejects(
    () => resolveSandbox(AGENT, INPUT, cfg('sometimes')),
    /Unknown sandboxMode/
  );
});

test('local mode runs the agent as a child process with env wiring', async () => {
  const config = localConfig();
  const output = await runContainerAgent(AGENT, { ...INPUT }, null, null, config);

  assert.equal(output.status, 'success');
  assert.equal(output.newSessionId, 'mock-session');

  const echo = JSON.parse(output.result);
  assert.equal(echo.prompt, 'hello');
  assert.equal(echo.agentId, 'main');
  assert.equal(echo.isMain, 'true');
  assert.equal(echo.workspace, join(config.agentsDir, 'main'));
  assert.equal(echo.ipcBase, join(config.dataDir, 'ipc', 'main'));

  // Local mode still provisions the agent + IPC directories
  assert.ok(existsSync(join(config.dataDir, 'ipc', 'main', 'input')));
  // Pidfile is cleaned up once the runner exits
  assert.deepEqual(readdirSync(join(config.dataDir, 'local-runners')), []);
});

test('local mode rejects when localRunner is missing or unset', async () => {
  await assert.rejects(
    () => runContainerAgent(AGENT, { ...INPUT }, null, null, localConfig({ localRunner: undefined })),
    /localRunner is not set/
  );
  await assert.rejects(
    () => runContainerAgent(AGENT, { ...INPUT }, null, null, localConfig({ localRunner: '/nope/missing.js' })),
    /localRunner not found/
  );
});

test('local mode kills a hanging runner on idle timeout, keeping the last output', async () => {
  const config = localConfig({ containerTimeout: 500 });
  const output = await runContainerAgent(AGENT, { ...INPUT, hang: true }, null, null, config);

  assert.equal(output.status, 'error');
  assert.match(output.error, /timed out/);
  // The reply that arrived before the hang is preserved
  assert.equal(JSON.parse(output.result).prompt, 'hello');
  assert.equal(output.newSessionId, 'mock-session');
});

test('orphan reaping kills stale local runners and cleans pidfiles', async () => {
  const config = localConfig();
  const pidDir = join(config.dataDir, 'local-runners');
  mkdirSync(pidDir, { recursive: true });

  // A live process pretending to be an orphan from a previous host run
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(join(pidDir, 'jsclaw-orphan-1.pid'), String(orphan.pid));
  // A stale pidfile whose process is long gone
  writeFileSync(join(pidDir, 'jsclaw-stale-2.pid'), '999999999');
  // A pidfile outside the prefix — must be left alone
  writeFileSync(join(pidDir, 'other-3.pid'), String(process.pid));

  const reaped = await reapOrphanContainers(config);

  assert.deepEqual(reaped, ['jsclaw-orphan-1']);
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => process.kill(orphan.pid, 0), /ESRCH/); // process is gone
  assert.deepEqual(readdirSync(pidDir).sort(), ['other-3.pid']);
});

test('skills reach the run: triggered bodies in the prompt, index in the input', async () => {
  const config = localConfig();
  mkdirSync(join(config.skillsDir, 'deploy-helper'), { recursive: true });
  writeFileSync(join(config.skillsDir, 'deploy-helper', 'SKILL.md'),
    '---\nname: deploy-helper\ndescription: helps with deploys\ntrigger: "deploy"\n---\nALWAYS RUN THE SMOKE TEST');
  mkdirSync(join(config.skillsDir, 'gh-issues'), { recursive: true });
  writeFileSync(join(config.skillsDir, 'gh-issues', 'SKILL.md'),
    '---\nname: gh-issues\ndescription: fetch github issues\n---\nLONG BODY NOT FOR THE INDEX');

  const output = await runContainerAgent(AGENT, { ...INPUT, prompt: 'please deploy the app' }, null, null, config);
  const echo = JSON.parse(output.result);

  // Triggered skill body prepended to the prompt
  assert.match(echo.prompt, /ALWAYS RUN THE SMOKE TEST/);
  assert.match(echo.prompt, /please deploy the app/);
  // Description-driven skill in the index with a readable (host) path, body excluded
  assert.match(echo.skillsIndex, /gh-issues.*fetch github issues/);
  assert.match(echo.skillsIndex, new RegExp(config.skillsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(!echo.skillsIndex.includes('LONG BODY'), 'index has no bodies');
});

test('sandboxed runs mount the skills dir read-only with rewritten index paths', async () => {
  const { buildVolumeMounts } = await import('../src/container-runner.js');
  const { resolveSkillsForRun } = await import('../src/container-runner.js');
  const config = localConfig();
  mkdirSync(join(config.skillsDir, 'gh-issues'), { recursive: true });
  writeFileSync(join(config.skillsDir, 'gh-issues', 'SKILL.md'),
    '---\nname: gh-issues\ndescription: fetch github issues\n---\nBODY');

  const mounts = buildVolumeMounts(AGENT, config);
  assert.ok(mounts.includes(`${config.skillsDir}:/workspace/skills:ro`), 'read-only skills mount present');

  const { skillsIndex } = resolveSkillsForRun(config, 'hello', false /* sandboxed */);
  assert.match(skillsIndex, /\/workspace\/skills\/gh-issues\/SKILL\.md/);
});
