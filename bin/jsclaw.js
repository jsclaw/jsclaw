#!/usr/bin/env node
/**
 * jsclaw CLI — same verbs as openclaw where they map.
 *
 *   jsclaw status                          Config, groups, task counts
 *   jsclaw doctor                          Environment health checks
 *   jsclaw tasks list [--group <folder>]   List scheduled tasks
 *   jsclaw tasks pause|resume|cancel <id>  Manage a task
 *   jsclaw memory list <group>             List memory files
 *   jsclaw memory search <group> <query>   Search memory
 *   jsclaw memory clear <group>            Delete a group's memory
 *   jsclaw run <group> <prompt...>         One-shot agent run
 *   jsclaw heartbeat <group> [--dry-run]   Trigger a heartbeat cycle now
 *
 * Exit codes: 0 success, 1 error, 2 usage/config error.
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConfig, loadConfigFile } from '../src/config.js';
import { TaskStore, computeNextRun } from '../src/task-store.js';
import { listMemoryFiles, searchMemory, clearMemory } from '../src/memory.js';
import { runContainerAgent, reapOrphanContainers } from '../src/container-runner.js';
import { HEARTBEAT_OK } from '../src/heartbeat.js';
import { loadSkills, parseSkill, installSkill, removeSkill, matchSkills } from '../src/skills.js';

const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8')
).version;

const USAGE = `jsclaw v${VERSION} — container orchestration for Claude AI agents

Usage:
  jsclaw status                          Show config, groups, task counts
  jsclaw doctor                          Check environment health
  jsclaw tasks list [--group <folder>]   List scheduled tasks
  jsclaw tasks pause <id>                Pause a task
  jsclaw tasks resume <id>               Resume a task
  jsclaw tasks cancel <id>               Cancel a task
  jsclaw memory list <group>             List a group's memory files
  jsclaw memory search <group> <query>   Search a group's memory
  jsclaw memory clear <group>            Delete a group's memory
  jsclaw run <group> <prompt...>         Run an agent once with a prompt
  jsclaw heartbeat <group> [--dry-run]   Trigger a heartbeat cycle now
  jsclaw reap                            Remove orphaned jsclaw containers
  jsclaw skill list                      List installed skills
  jsclaw skill install <path>            Install a SKILL.md file
  jsclaw skill remove <name>             Remove an installed skill
  jsclaw skill test <path> <message...>  Check whether a message triggers a skill
  jsclaw config list                     Show effective configuration
  jsclaw config get <key>                Read a config value
  jsclaw config set <key> <value>        Write a value to jsclaw.json

Options:
  --group <folder>   Filter tasks by group
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

function listGroups(config) {
  try {
    return readdirSync(config.groupsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// --- Commands ---

function cmdStatus(config, store, json) {
  const groups = listGroups(config);
  const tasks = store.listTasks();
  const active = tasks.filter((t) => t.status === 'active').length;

  if (json) {
    console.log(JSON.stringify({
      version: VERSION,
      containerRuntime: config.containerRuntime,
      containerImage: config.containerImage,
      dataDir: config.dataDir,
      groupsDir: config.groupsDir,
      groups,
      tasks: { total: tasks.length, active },
    }, null, 2));
    return;
  }

  console.log(`jsclaw v${VERSION}`);
  console.log(`  runtime:  ${config.containerRuntime} (${config.containerImage})`);
  console.log(`  data:     ${config.dataDir}`);
  console.log(`  groups:   ${config.groupsDir} (${groups.length}: ${groups.join(', ') || 'none'})`);
  console.log(`  tasks:    ${tasks.length} total, ${active} active`);
  for (const g of groups) {
    const hb = existsSync(join(config.groupsDir, g, 'HEARTBEAT.md'));
    const soul = existsSync(join(config.groupsDir, g, 'SOUL.md'));
    const mem = existsSync(join(config.groupsDir, g, 'memory'));
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
  check(`groupsDir writable: ${config.groupsDir}`, () => {
    execSync(`mkdir -p ${JSON.stringify(config.groupsDir)}`);
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
      const tasks = store.listTasks(opts.group);
      if (opts.json) return console.log(JSON.stringify(tasks, null, 2));
      if (tasks.length === 0) return console.log('no tasks');
      for (const t of tasks) {
        console.log(`${t.id}  [${t.status}]  ${t.scheduleType}:${t.scheduleValue}  ${t.groupFolder}  next:${t.nextRun || '-'}`);
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
  const group = args[0];
  if (!group) fail(`memory ${sub || ''} requires a group`, 2);
  switch (sub) {
    case 'list': {
      const files = listMemoryFiles(group, config);
      if (opts.json) return console.log(JSON.stringify(files, null, 2));
      if (files.length === 0) return console.log('no memory files');
      for (const f of files) console.log(`${f.name}  ${f.size} chars`);
      break;
    }
    case 'search': {
      const query = args.slice(1).join(' ');
      if (!query) fail('memory search requires a query', 2);
      const hits = searchMemory(group, query, config);
      if (opts.json) return console.log(JSON.stringify(hits, null, 2));
      if (hits.length === 0) return console.log('no matches');
      for (const h of hits) console.log(`${h.file}:${h.line}  ${h.text}`);
      break;
    }
    case 'clear':
      clearMemory(group, config);
      console.log(`cleared memory for ${group}`);
      break;
    default:
      fail(`unknown memory subcommand: ${sub || '(none)'}`, 2);
  }
}

async function cmdRun(config, group, prompt) {
  if (!group || !prompt) fail('run requires a group and a prompt', 2);
  const result = await runContainerAgent(
    { name: group, folder: group },
    { prompt, groupFolder: group, chatJid: 'cli', isMain: true },
    null,
    async (output) => {
      if (output.result) console.log(output.result);
    },
    config,
  );
  if (result.status === 'error') fail(result.error || 'agent run failed');
}

async function cmdHeartbeat(config, group, dryRun) {
  if (!group) fail('heartbeat requires a group', 2);
  const hbPath = join(config.groupsDir, group, 'HEARTBEAT.md');
  if (!existsSync(hbPath)) fail(`no HEARTBEAT.md in ${join(config.groupsDir, group)}`);
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
    { name: group, folder: group },
    { prompt, groupFolder: group, chatJid: 'heartbeat', isMain: true },
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
        console.log(`${s.name}${s.version ? ` v${s.version}` : ''}  trigger:${s.trigger}`);
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
  'heartbeatInterval', 'dataDir', 'groupsDir', 'skillsDir', 'mountAllowlistPath',
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

// --- Main ---

async function main() {
  const { values: opts, positionals } = parseArgs({
    options: {
      group: { type: 'string' },
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
