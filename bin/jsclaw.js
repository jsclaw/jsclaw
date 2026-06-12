#!/usr/bin/env node
/**
 * jsclaw CLI — same verbs as openclaw where they map.
 *
 *   jsclaw status                          Config, agents, task counts
 *   jsclaw doctor                          Environment health checks
 *   jsclaw tasks list [--agent <folder>]   List scheduled tasks
 *   jsclaw tasks pause|resume|cancel <id>  Manage a task
 *   jsclaw memory list <agent>             List memory files
 *   jsclaw memory search <agent> <query>   Search memory
 *   jsclaw memory clear <agent>            Delete an agent's memory
 *   jsclaw run <agent> <prompt...>         One-shot agent run
 *   jsclaw heartbeat <agent> [--dry-run]   Trigger a heartbeat cycle now
 *
 * Exit codes: 0 success, 1 error, 2 usage/config error.
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { randomBytes } from 'node:crypto';
import { createConfig, loadConfigFile } from '../src/config.js';
import { TaskStore, computeNextRun, createTaskIpcHandler } from '../src/task-store.js';
import { startTaskScheduler } from '../src/task-scheduler.js';
import { startIpcWatcher } from '../src/ipc.js';
import { listMemoryFiles, searchMemory, clearMemory } from '../src/memory.js';
import { runContainerAgent, reapOrphanContainers } from '../src/container-runner.js';
import { startHeartbeat, HEARTBEAT_OK } from '../src/heartbeat.js';
import { startGateway } from '../src/gateway.js';
import { SessionStore } from '../src/sessions.js';
import { loadPlugins } from '../src/plugins.js';
import { registerPluginCommands } from '../src/commands.js';
import { CHANNEL_FACTORIES } from '../src/channels.js';
import { normalizeAgentId } from '../src/agents.js';
import { startChannels } from '../src/channels.js';
import { loadSkills, parseSkill, installSkill, removeSkill, matchSkills } from '../src/skills.js';

const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8')
).version;

const USAGE = `jsclaw v${VERSION} — container orchestration for Claude AI agents

Usage:
  jsclaw onboard                         Interactive setup wizard
  jsclaw status                          Show config, agents, task counts
  jsclaw doctor                          Check environment health
  jsclaw tasks list [--agent <folder>]   List scheduled tasks
  jsclaw tasks pause <id>                Pause a task
  jsclaw tasks resume <id>               Resume a task
  jsclaw tasks cancel <id>               Cancel a task
  jsclaw memory list <agent>             List an agent's memory files
  jsclaw memory search <agent> <query>   Search an agent's memory
  jsclaw memory clear <agent>            Delete an agent's memory
  jsclaw run <agent> <prompt...>         Run an agent once with a prompt
  jsclaw heartbeat <agent> [--dry-run]   Trigger a heartbeat cycle now
  jsclaw reap                            Remove orphaned jsclaw containers
  jsclaw gateway [--port <n>]            Run the full agent host: gateway,
                                         webchat, scheduler, heartbeat, IPC
  jsclaw skill list                      List installed skills
  jsclaw skill install <path>            Install a SKILL.md file
  jsclaw skill remove <name>             Remove an installed skill
  jsclaw skill test <path> <message...>  Check whether a message triggers a skill
  jsclaw config list                     Show effective configuration
  jsclaw config get <key>                Read a config value
  jsclaw config set <key> <value>        Write a value to jsclaw.json

Options:
  --agent <folder>   Filter tasks by agent
  --dry-run          Show what would run without running it
  --json             Machine-readable output
  --version, -v      Show version
  --help, -h         Show this help`;

// Quiet logger so CLI output stays clean; errors still surface.
const cliLogger = {
  debug() {}, info() {}, warn() {},
  error: (msg, data) => console.error(`error: ${msg}`, data ? JSON.stringify(data) : ''),
  fatal: (msg, data) => console.error(`fatal: ${msg}`, data ? JSON.stringify(data) : ''),
};

function fail(message, code = 1) {
  console.error(`jsclaw: ${message}`);
  process.exit(code);
}

function listAgents(config) {
  try {
    return readdirSync(config.agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// --- Commands ---

function cmdStatus(config, store, json) {
  const agents = listAgents(config);
  const tasks = store.listTasks();
  const active = tasks.filter((t) => t.status === 'active').length;

  if (json) {
    console.log(JSON.stringify({
      version: VERSION,
      containerRuntime: config.containerRuntime,
      containerImage: config.containerImage,
      dataDir: config.dataDir,
      agentsDir: config.agentsDir,
      agents,
      tasks: { total: tasks.length, active },
    }, null, 2));
    return;
  }

  console.log(`jsclaw v${VERSION}`);
  console.log(`  runtime:  ${config.containerRuntime} (${config.containerImage})`);
  console.log(`  data:     ${config.dataDir}`);
  console.log(`  agents:   ${config.agentsDir} (${agents.length}: ${agents.join(', ') || 'none'})`);
  console.log(`  tasks:    ${tasks.length} total, ${active} active`);
  for (const g of agents) {
    const hb = existsSync(join(config.agentsDir, g, 'HEARTBEAT.md'));
    const soul = existsSync(join(config.agentsDir, g, 'SOUL.md'));
    const mem = existsSync(join(config.agentsDir, g, 'memory'));
    const flags = [hb && 'heartbeat', soul && 'soul', mem && 'memory'].filter(Boolean);
    if (flags.length) console.log(`    ${g}: ${flags.join(', ')}`);
  }
}

function cmdDoctor(config) {
  let failed = 0;
  const check = (label, fn) => {
    try {
      const detail = fn();
      console.log(`  ok    ${label}${detail ? ` (${detail})` : ''}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${label}: ${err.message}`);
    }
  };

  console.log('jsclaw doctor');
  check('node >= 20', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) throw new Error(`found ${process.versions.node}`);
    return process.versions.node;
  });
  check(`container runtime: ${config.containerRuntime}`, () =>
    execSync(`${config.containerRuntime} --version`, { stdio: 'pipe' }).toString().trim().split('\n')[0]
  );
  check(`image: ${config.containerImage}`, () => {
    const out = execSync(
      `${config.containerRuntime} image inspect ${config.containerImage} --format ok`,
      { stdio: 'pipe' }
    ).toString().trim();
    if (!out) throw new Error('not built — run: npm run docker:build');
    return 'built';
  });
  check('ANTHROPIC_API_KEY set', () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('not set');
    return 'set';
  });
  check(`dataDir writable: ${config.dataDir}`, () => {
    execSync(`mkdir -p ${JSON.stringify(config.dataDir)}`);
    return '';
  });
  check(`agentsDir writable: ${config.agentsDir}`, () => {
    execSync(`mkdir -p ${JSON.stringify(config.agentsDir)}`);
    return '';
  });

  if (failed > 0) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

function cmdTasks(config, store, sub, args, opts) {
  switch (sub) {
    case 'list': {
      const tasks = store.listTasks(opts.agent);
      if (opts.json) return console.log(JSON.stringify(tasks, null, 2));
      if (tasks.length === 0) return console.log('no tasks');
      for (const t of tasks) {
        console.log(`${t.id}  [${t.status}]  ${t.scheduleType}:${t.scheduleValue}  ${t.agentId}  next:${t.nextRun || '-'}`);
        console.log(`          ${t.prompt.slice(0, 100)}`);
      }
      break;
    }
    case 'pause':
    case 'resume':
    case 'cancel': {
      const id = args[0];
      if (!id) fail(`tasks ${sub} requires a task id`, 2);
      const task = store.getTask(id);
      if (!task) fail(`task not found: ${id}`);
      if (sub === 'cancel') {
        store.deleteTask(id);
        console.log(`cancelled ${id}`);
      } else {
        const status = sub === 'pause' ? 'paused' : 'active';
        const fields = { status };
        if (status === 'active') fields.nextRun = computeNextRun(task);
        store.updateTask(id, fields);
        console.log(`${status === 'paused' ? 'paused' : 'resumed'} ${id}`);
      }
      break;
    }
    default:
      fail(`unknown tasks subcommand: ${sub || '(none)'}`, 2);
  }
}

function cmdMemory(config, sub, args, opts) {
  const agent = args[0];
  if (!agent) fail(`memory ${sub || ''} requires an agent`, 2);
  switch (sub) {
    case 'list': {
      const files = listMemoryFiles(agent, config);
      if (opts.json) return console.log(JSON.stringify(files, null, 2));
      if (files.length === 0) return console.log('no memory files');
      for (const f of files) console.log(`${f.name}  ${f.size} chars`);
      break;
    }
    case 'search': {
      const query = args.slice(1).join(' ');
      if (!query) fail('memory search requires a query', 2);
      const hits = searchMemory(agent, query, config);
      if (opts.json) return console.log(JSON.stringify(hits, null, 2));
      if (hits.length === 0) return console.log('no matches');
      for (const h of hits) console.log(`${h.file}:${h.line}  ${h.text}`);
      break;
    }
    case 'clear':
      clearMemory(agent, config);
      console.log(`cleared memory for ${agent}`);
      break;
    default:
      fail(`unknown memory subcommand: ${sub || '(none)'}`, 2);
  }
}

async function cmdRun(config, agent, prompt) {
  if (!agent || !prompt) fail('run requires an agent and a prompt', 2);
  const result = await runContainerAgent(
    { name: agent, folder: agent },
    { prompt, agentId: agent, chatJid: 'cli', isMain: true },
    null,
    async (output) => {
      if (output.result) console.log(output.result);
    },
    config,
  );
  if (result.status === 'error') fail(result.error || 'agent run failed');
}

async function cmdHeartbeat(config, agent, dryRun) {
  if (!agent) fail('heartbeat requires an agent', 2);
  const hbPath = join(config.agentsDir, agent, 'HEARTBEAT.md');
  if (!existsSync(hbPath)) fail(`no HEARTBEAT.md in ${join(config.agentsDir, agent)}`);
  const tasks = readFileSync(hbPath, 'utf-8').trim();

  const prompt = `[HEARTBEAT]
Read the tasks below (from HEARTBEAT.md) and check whether any of them need action right now.

- If nothing needs attention, reply with exactly: ${HEARTBEAT_OK}
- If something needs action, take it (use your tools), then summarize what you did.

${tasks}`;

  if (dryRun) {
    console.log('--- would send this heartbeat prompt ---');
    console.log(prompt);
    return;
  }

  const result = await runContainerAgent(
    { name: agent, folder: agent },
    { prompt, agentId: agent, chatJid: 'heartbeat', isMain: true },
    null, null, config,
  );
  const text = result.result?.trim() || '';
  if (!text || text.startsWith(HEARTBEAT_OK)) {
    console.log(HEARTBEAT_OK);
  } else {
    console.log(text);
  }
  if (result.status === 'error') fail(result.error || 'heartbeat failed');
}

function cmdSkill(config, sub, args, opts) {
  switch (sub) {
    case 'list': {
      const skills = loadSkills(config);
      if (opts.json) return console.log(JSON.stringify(skills.map(({ body, ...s }) => s), null, 2));
      if (skills.length === 0) return console.log('no skills installed');
      for (const s of skills) {
        console.log(`${s.name}${s.version ? ` v${s.version}` : ''}  ${s.trigger ? `trigger:${s.trigger}` : 'description-driven'}`);
        console.log(`          ${s.description}`);
      }
      break;
    }
    case 'install': {
      const path = args[0];
      if (!path) fail('skill install requires a path', 2);
      const skill = installSkill(path, config);
      console.log(`installed ${skill.name} -> ${skill.path}`);
      break;
    }
    case 'remove': {
      const name = args[0];
      if (!name) fail('skill remove requires a name', 2);
      if (!removeSkill(name, config)) fail(`skill not found: ${name}`);
      console.log(`removed ${name}`);
      break;
    }
    case 'test': {
      const [path, ...messageParts] = args;
      const message = messageParts.join(' ');
      if (!path || !message) fail('skill test requires a path and a message', 2);
      const skill = parseSkill(readFileSync(path, 'utf-8'), path);
      if (skill.trigger == null) {
        console.log(`description-driven  ${skill.name} — always surfaced in the skills index; the agent decides from the description`);
        break;
      }
      const matched = matchSkills([skill], { text: message });
      if (matched.length > 0) {
        console.log(`MATCH  ${skill.name} (trigger: ${skill.trigger})`);
      } else {
        console.log(`no match  ${skill.name} (trigger: ${skill.trigger})`);
        process.exitCode = 1;
      }
      break;
    }
    default:
      fail(`unknown skill subcommand: ${sub || '(none)'}`, 2);
  }
}

// Config keys that may be read/written via the CLI (everything except logger).
const CONFIG_KEYS = [
  'containerImage', 'containerRuntime', 'containerTimeout', 'maxOutputSize',
  'maxConcurrentContainers', 'ipcPollInterval', 'schedulerPollInterval',
  'heartbeatInterval', 'dataDir', 'agentsDir', 'skillsDir', 'mountAllowlistPath',
];

function cmdConfig(config, sub, args, opts) {
  switch (sub) {
    case 'list': {
      const visible = {};
      for (const key of CONFIG_KEYS) visible[key] = config[key];
      if (opts.json) return console.log(JSON.stringify(visible, null, 2));
      for (const [k, v] of Object.entries(visible)) console.log(`${k} = ${v === undefined ? '(unset)' : v}`);
      break;
    }
    case 'get': {
      const key = args[0];
      if (!key) fail('config get requires a key', 2);
      if (!CONFIG_KEYS.includes(key)) fail(`unknown config key: ${key}`, 2);
      const value = config[key];
      console.log(value === undefined ? '(unset)' : String(value));
      break;
    }
    case 'set': {
      const [key, ...valueParts] = args;
      const value = valueParts.join(' ');
      if (!key || value === '') fail('config set requires a key and a value', 2);
      if (!CONFIG_KEYS.includes(key)) fail(`unknown config key: ${key}`, 2);

      const path = process.env.JSCLAW_CONFIG_PATH || join(process.cwd(), 'jsclaw.json');
      const { file } = loadConfigFile();
      const numeric = /^(containerTimeout|maxOutputSize|maxConcurrentContainers|ipcPollInterval|schedulerPollInterval|heartbeatInterval)$/.test(key);
      file[key] = numeric ? Number(value) : value;
      writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
      console.log(`${key} = ${file[key]} (written to ${path})`);
      break;
    }
    default:
      fail(`unknown config subcommand: ${sub || '(none)'}`, 2);
  }
}

async function cmdGateway(config, opts) {
  const verboseLogger = createConfig().logger; // real logger for a long-running host
  config = createConfig({ logger: verboseLogger });
  const port = opts.port ? Number(opts.port) : 18789;
  const token = config.gatewayToken || randomBytes(16).toString('hex');

  // 1. Clean up after any previous crashed host
  const reaped = await reapOrphanContainers(config);
  if (reaped.length) console.log(`reaped ${reaped.length} orphaned container(s)`);

  // 2. Core wiring: store, agent runner, queue-less direct runs
  const store = new TaskStore(config);
  const sessions = new SessionStore(config);

  // 2b. Plugins (#64): register into the existing seams before anything boots
  const { registrations: plugins, plugins: loadedPlugins } = await loadPlugins(config, { logger: config.logger });
  registerPluginCommands(plugins.commands);
  const agents = () => listAgents(config);

  const runAgent = (rawAgentId, prompt, onOutput, extra = {}) => {
    const agentId = normalizeAgentId(rawAgentId);
    return runContainerAgent(
      { name: agentId, folder: agentId },
      { prompt, agentId, chatJid: `gateway:${agentId}`, isMain: true, ...extra },
      null,
      onOutput ? async (output) => onOutput(output) : null,
      config,
    );
  };

  // 3. Gateway first so subsystems can broadcast to clients
  const gateway = await startGateway({
    runAgent,
    store,
    sessions,
    plugins,
    getAgents: agents,
    triggerHeartbeat: () => heartbeat.triggerNow(),
  }, config, { port, token });

  // 4. Agent-initiated messages and task ops
  startIpcWatcher({
    sendMessage: async (jid, text, sender) => {
      gateway.broadcast('message', { jid, text, sender });
    },
    onTask: createTaskIpcHandler(store, { logger: config.logger }),
    getRegisteredAgents: () => ({}),
  }, config);

  // 5. Scheduler executes what agents schedule
  startTaskScheduler({
    store,
    runTask: async (task) => {
      const result = await runAgent(task.agentId, task.prompt, null);
      gateway.broadcast('task.completed', { taskId: task.id, status: result.status });
    },
  }, config);

  // 6. Channels from config (#44) — registry-built, bindings-routed
  let channels = { channels: [], stop: async () => {} };
  try {
    channels = await startChannels({
      config, runAgent, logger: config.logger, sessions,
      registry: { ...CHANNEL_FACTORIES, ...plugins.channels },
    });
  } catch (err) {
    fail(err.message, 2);
  }

  // 7. Heartbeat wakes agents with a HEARTBEAT.md
  const heartbeat = startHeartbeat({
    getAgents: () => agents().map((folder) => ({ name: folder, folder })),
    // Heartbeats run on the cheap model when one is configured —
    // openclaw's biggest cost lever for the 48-cycles/day loop
    runAgent: (agent, prompt) => runAgent(agent.folder, prompt, null,
      config.heartbeatModel ? { model: config.heartbeatModel } : {}),
    onAlert: async (agent, result) => {
      gateway.broadcast('heartbeat.alert', { agentId: agent.folder, result });
    },
  }, config);

  console.log(`\njsclaw gateway v${VERSION}`);
  console.log(`  chat:    http://127.0.0.1:${gateway.port}/chat?token=${token}`);
  console.log(`  ws:      ws://127.0.0.1:${gateway.port}/?token=${token}`);
  console.log(`  agents:  ${agents().join(', ') || '(none yet — first chat creates one)'}`);
  for (const ch of channels.channels) {
    console.log(`  ${ch.name}:${' '.repeat(Math.max(1, 8 - ch.name.length))}${ch.npub || ch.username || 'connected'}`);
  }
  console.log(`  token:   ${token}${config.gatewayToken ? ' (pinned)' : ' (generated; set JSCLAW_GATEWAY_TOKEN or gatewayToken in jsclaw.json to pin)'}`);
  if (config.model) console.log(`  model:   ${config.model}${config.heartbeatModel ? ` (heartbeat: ${config.heartbeatModel})` : ''}`);
  if (loadedPlugins.length) console.log(`  plugins: ${loadedPlugins.map((p) => p.id).join(', ')}`);
  console.log('\nCtrl-C to stop.');

  await new Promise((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, resolve);
    }
  });
  console.log('\nshutting down…');
  heartbeat.stop();
  await channels.stop();
  await gateway.stop();
  process.exit(0);
}

// --- Main ---

async function main() {
  const { values: opts, positionals } = parseArgs({
    options: {
      agent: { type: 'string' },
      port: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (opts.version) return console.log(VERSION);
  if (opts.help || positionals.length === 0) return console.log(USAGE);

  const config = createConfig({ logger: cliLogger });
  const [command, ...rest] = positionals;

  switch (command) {
    case 'status':
      return cmdStatus(config, new TaskStore(config), opts.json);
    case 'doctor':
      return cmdDoctor(config);
    case 'tasks':
      return cmdTasks(config, new TaskStore(config), rest[0], rest.slice(1), opts);
    case 'memory':
      return cmdMemory(config, rest[0], rest.slice(1), opts);
    case 'run':
      return cmdRun(config, rest[0], rest.slice(1).join(' '));
    case 'heartbeat':
      return cmdHeartbeat(config, rest[0], opts['dry-run']);
    case 'onboard': {
      const { runOnboard } = await import('./onboard.js');
      return runOnboard({ config });
    }
    case 'gateway':
      return cmdGateway(config, opts);
    case 'reap': {
      const reaped = await reapOrphanContainers(config);
      if (opts.json) return console.log(JSON.stringify(reaped));
      if (reaped.length === 0) return console.log('no orphaned containers');
      for (const name of reaped) console.log(`reaped ${name}`);
      return;
    }
    case 'skill':
      return cmdSkill(config, rest[0], rest.slice(1), opts);
    case 'config':
      return cmdConfig(config, rest[0], rest.slice(1), opts);
    default:
      fail(`unknown command: ${command}\n\n${USAGE}`, 2);
  }
}

main().catch((err) => fail(err.message));
