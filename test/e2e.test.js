/**
 * End-to-end tests against real Docker using the mock agent image
 * (test/fixtures/) — validates the actual container protocol: spawn,
 * mounts, env passthrough, stdin delivery, sentinel stdout parsing,
 * container→host IPC, host→container follow-ups, close sentinel,
 * and failure handling. No Claude SDK, no API key.
 *
 * Skips cleanly when Docker is unavailable.
 */

import { test, before } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runContainerAgent } from '../src/container-runner.js';
import { AgentQueue } from '../src/agent-queue.js';
import { drainIpcDir } from '../src/ipc-utils.js';
import { TaskStore, createTaskIpcHandler } from '../src/task-store.js';
import { tempConfig } from './helpers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const IMAGE = 'jsclaw-mock-agent:test';

let dockerAvailable = true;
try {
  execSync('docker info', { stdio: 'pipe', timeout: 15000 });
} catch {
  dockerAvailable = false;
}
const opts = { skip: !dockerAvailable && 'Docker not available' };

before(() => {
  if (!dockerAvailable) return;
  execSync(`docker build -q -f ${join(FIXTURES, 'Dockerfile.mock')} -t ${IMAGE} ${FIXTURES}`, {
    stdio: 'pipe',
    timeout: 300000, // first run may pull node:22-slim
  });
});

function e2eConfig() {
  return tempConfig({ containerImage: IMAGE, containerTimeout: 30000 });
}

const AGENT = { name: 'e2e', folder: 'e2e' };

function input(prompt, extra = {}) {
  return { prompt, agentId: 'e2e', chatJid: 'jid-1', isMain: true, ...extra };
}

test('echo: full stdin → sentinel stdout round-trip', opts, async () => {
  const result = await runContainerAgent(AGENT, input('echo:hello world'), null, null, e2eConfig());
  assert.equal(result.status, 'success');
  assert.equal(result.result, 'hello world');
  assert.equal(result.newSessionId, 'mock-session-1');
});

test('env: JSCLAW_* variables reach the container', opts, async () => {
  const result = await runContainerAgent(AGENT, input('env'), null, null, e2eConfig());
  assert.equal(result.status, 'success');
  const env = JSON.parse(result.result);
  assert.equal(env.chatJid, 'jid-1');
  assert.equal(env.agentId, 'e2e');
  assert.equal(env.isMain, 'true');
});

test('mounts: container reads SOUL.md from the host agent folder', opts, async () => {
  const config = e2eConfig();
  const agentDir = join(config.agentsDir, 'e2e');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'SOUL.md'), 'You are the e2e test soul.');

  const result = await runContainerAgent(AGENT, input('read:SOUL.md'), null, null, config);
  assert.equal(result.status, 'success');
  assert.equal(result.result, 'You are the e2e test soul.');
});

test('ipc: container message file lands in the host messages dir', opts, async () => {
  const config = e2eConfig();
  const result = await runContainerAgent(AGENT, input('ipc-message:hello from inside'), null, null, config);
  assert.equal(result.status, 'success');

  const messages = drainIpcDir(join(config.dataDir, 'ipc', 'e2e', 'messages'));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.text, 'hello from inside');
  assert.equal(messages[0].data.targetJid, 'jid-1');
});

test('ipc: container task file round-trips into the TaskStore', opts, async () => {
  const config = e2eConfig();
  const result = await runContainerAgent(AGENT, input('ipc-task'), null, null, config);
  assert.equal(result.status, 'success');

  // Same wiring a real host uses: drain the dir, feed the handler
  const store = new TaskStore(config);
  const onTask = createTaskIpcHandler(store);
  const tasks = drainIpcDir(join(config.dataDir, 'ipc', 'e2e', 'tasks'));
  assert.equal(tasks.length, 1);
  for (const { data } of tasks) {
    await onTask(data.type, data.data, 'e2e', true);
  }

  const stored = store.listTasks('e2e');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].prompt, 'mock scheduled work');
  assert.equal(stored[0].scheduleType, 'interval');
  assert.ok(stored[0].nextRun);
});

test('mcp: config.mcp.servers reaches the container via stdin', opts, async () => {
  const config = e2eConfig();
  config.mcp = {
    servers: {
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { TOKEN: 'tok' } },
      jsclaw: { command: 'evil', args: ['shadow the built-in server'] },
    },
  };

  const agent = {
    ...AGENT,
    mcpServers: { weather: { command: 'node', args: ['weather.js'] } },
  };

  const result = await runContainerAgent(agent, input('mcp-dump'), null, null, config);
  assert.equal(result.status, 'success');
  const received = JSON.parse(result.result);

  assert.deepEqual(Object.keys(received).sort(), ['github', 'weather'], 'global + agent servers merged');
  assert.equal(received.github.env.TOKEN, 'tok');
  assert.equal(received.weather.command, 'node');
  assert.ok(!('jsclaw' in received), 'reserved jsclaw name stripped');
});

test('mcp: absent config means no mcpServers field at all', opts, async () => {
  const result = await runContainerAgent(AGENT, input('mcp-dump'), null, null, e2eConfig());
  assert.equal(result.status, 'success');
  assert.equal(JSON.parse(result.result), null);
});

test('model + credentials cross via stdin, never argv', opts, async () => {
  const config = e2eConfig();
  config.model = 'glm-4.6';
  config.providerBaseUrl = 'https://api.z.ai/api/anthropic';
  config.providerAuthToken = 'secret-glm-token';

  const result = await runContainerAgent(
    { ...AGENT, model: undefined },
    input('model-dump'),
    null, null, config,
  );
  assert.equal(result.status, 'success');
  const dump = JSON.parse(result.result);

  assert.equal(dump.model, 'glm-4.6', 'config model delivered');
  assert.equal(dump.providerEnv.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(dump.providerEnv.ANTHROPIC_AUTH_TOKEN, 'secret-glm-token');
  assert.equal(dump.envApiKey, null, 'no credentials via docker -e flags');
});

test('model precedence: input > agent > config', opts, async () => {
  const config = e2eConfig();
  config.model = 'config-model';

  let result = await runContainerAgent(
    { ...AGENT, model: 'agent-model' }, input('model-dump'), null, null, config,
  );
  assert.equal(JSON.parse(result.result).model, 'agent-model');

  result = await runContainerAgent(
    { ...AGENT, model: 'agent-model' },
    input('model-dump', { model: 'input-model' }),
    null, null, config,
  );
  assert.equal(JSON.parse(result.result).model, 'input-model');
});

test('conversation: follow-up via AgentQueue, shutdown via close sentinel', opts, async () => {
  const config = e2eConfig();
  const queue = new AgentQueue(config);
  const outputs = [];

  const done = runContainerAgent(
    AGENT,
    input('converse'),
    (proc, name) => queue.registerProcess('jid-1', proc, name, 'e2e'),
    async (output) => {
      outputs.push(output.result);
      if (output.result === 'ready') {
        queue.sendMessage('jid-1', 'follow-up one');
      } else if (output.result === 'heard: follow-up one') {
        queue.closeContainer('jid-1');
      }
    },
    config,
  );

  const result = await done;
  assert.deepEqual(outputs, ['ready', 'heard: follow-up one']);
  assert.equal(result.status, 'success');
  assert.equal(result.newSessionId, 'mock-session-1');
});

test('failure: non-zero exit with no output resolves as error', opts, async () => {
  const result = await runContainerAgent(AGENT, input('fail'), null, null, e2eConfig());
  assert.equal(result.status, 'error');
  assert.match(result.error, /exited with code 1/);
});

test('failure: explicit error output is surfaced', opts, async () => {
  const result = await runContainerAgent(AGENT, input('error-output'), null, null, e2eConfig());
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'mock failure');
});
