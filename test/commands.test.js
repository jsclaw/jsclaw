/**
 * Slash command tests — parsing, openclaw-shaped listing, built-in
 * execution, the user-invocable skill bridge, and unknown commands.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCommand, listCommands, handleCommand, BUILTIN_COMMANDS } from '../src/commands.js';
import { tempConfig } from './helpers.js';

function configWithSkills() {
  const config = tempConfig();
  mkdirSync(join(config.skillsDir, 'echo'), { recursive: true });
  writeFileSync(join(config.skillsDir, 'echo', 'SKILL.md'),
    '---\nname: echo\ndescription: echo things back\nuser-invocable: true\n---\nReply in the ECHO format.');
  mkdirSync(join(config.skillsDir, 'lore'), { recursive: true });
  writeFileSync(join(config.skillsDir, 'lore', 'SKILL.md'),
    '---\nname: lore\ndescription: background knowledge\n---\nNot invocable.');
  return config;
}

test('parseCommand recognizes slash commands and arguments', () => {
  assert.deepEqual(parseCommand('/reset'), { name: 'reset', args: '' });
  assert.deepEqual(parseCommand('  /Echo hello world '), { name: 'echo', args: 'hello world' });
  assert.equal(parseCommand('not a command'), null);
  assert.equal(parseCommand('half /way'), null);
  assert.equal(parseCommand(''), null);
});

test('listCommands merges built-ins with user-invocable skills, openclaw shape', () => {
  const commands = listCommands(configWithSkills());
  const names = commands.map((c) => c.name);
  assert.ok(names.includes('/reset') && names.includes('/help'));
  assert.ok(names.includes('/echo'), 'user-invocable skill surfaces as a command');
  assert.ok(!names.includes('/lore'), 'non-invocable skills stay out');

  const echo = commands.find((c) => c.name === '/echo');
  assert.equal(echo.source, 'skill');
  assert.equal(echo.acceptsArgs, true);
  const reset = commands.find((c) => c.name === '/reset');
  assert.equal(reset.source, 'native');
  assert.deepEqual(reset.textAliases, ['/reset', '/new']);
});

test('built-ins execute host-side', async () => {
  const config = configWithSkills();
  let resetCalled = false;
  const ctx = { config, agentId: 'main', version: '9.9.9', reset: () => { resetCalled = true; } };

  const reset = await handleCommand('/new', ctx); // alias
  assert.equal(resetCalled, true);
  assert.match(reset.reply, /starts fresh/);

  const status = await handleCommand('/status', ctx);
  assert.match(status.reply, /jsclaw v9\.9\.9/);
  assert.match(status.reply, /agent: main/);
  assert.match(status.reply, /skills: 2/);

  const skills = await handleCommand('/skills', ctx);
  assert.match(skills.reply, /echo \(\/echo\)/);
  assert.match(skills.reply, /lore — background knowledge/);

  const help = await handleCommand('/help', ctx);
  assert.match(help.reply, /\/reset — /);
  assert.match(help.reply, /\/echo — /);
});

test('skill commands force-inject the body; unknown commands answer politely', async () => {
  const ctx = { config: configWithSkills(), agentId: 'main' };

  const invoked = await handleCommand('/echo hello there', ctx);
  assert.ok(invoked.prompt, 'skill command transforms into a prompt');
  assert.match(invoked.prompt, /ECHO format/);
  assert.match(invoked.prompt, /hello there/);

  const bare = await handleCommand('/echo', ctx);
  assert.match(bare.prompt, /invoked \/echo/);

  const unknown = await handleCommand('/frobnicate', ctx);
  assert.match(unknown.reply, /Unknown command: \/frobnicate/);

  assert.equal(await handleCommand('plain message', ctx), null);
});
