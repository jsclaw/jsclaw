import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  initMemory, listMemoryFiles, loadMemoryContext,
  appendMemory, searchMemory, clearMemory,
} from '../src/memory.js';
import { tempConfig } from './helpers.js';

test('initMemory seeds openclaw categories without clobbering', () => {
  const config = tempConfig();
  initMemory('main', config);
  const names = listMemoryFiles('main', config).map((f) => f.name);
  assert.deepEqual(names, ['contacts.md', 'learnings.md', 'preferences.md', 'projects.md']);

  appendMemory('main', 'preferences', 'a fact', config);
  initMemory('main', config); // re-init must not erase
  assert.equal(searchMemory('main', 'a fact', config).length, 1);
});

test('heading-only files are excluded from context', () => {
  const config = tempConfig();
  initMemory('main', config);
  assert.equal(loadMemoryContext('main', config), '');

  appendMemory('main', 'preferences', 'likes light themes', config);
  const ctx = loadMemoryContext('main', config);
  assert.ok(ctx.startsWith('# Memory'));
  assert.ok(ctx.includes('likes light themes'));
});

test('custom categories and search', () => {
  const config = tempConfig();
  appendMemory('main', 'recipes', 'Carbonara: no cream, ever', config);
  const hits = searchMemory('main', 'carbonara', config); // case-insensitive
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'recipes.md');
  assert.ok(hits[0].line > 0);
  assert.equal(searchMemory('main', 'nonexistent', config).length, 0);
});

test('append neutralizes path traversal', () => {
  const config = tempConfig();
  appendMemory('main', '../../escape.md', 'nope', config);
  const root = dirname(config.groupsDir);
  assert.ok(!existsSync(join(root, 'escape.md')));
  assert.ok(existsSync(join(config.groupsDir, 'main', 'memory', 'escape.md')));
});

test('context respects the char budget', () => {
  const config = tempConfig();
  appendMemory('main', 'projects', 'x'.repeat(20000), config);
  appendMemory('main', 'zlast', 'should be cut', config);
  const ctx = loadMemoryContext('main', config, { maxChars: 500 });
  assert.ok(ctx.length < 800);
  assert.ok(ctx.includes('[...memory truncated]'));
  assert.ok(!ctx.includes('should be cut'));
});

test('clearMemory removes everything; empty group is safe', () => {
  const config = tempConfig();
  initMemory('main', config);
  clearMemory('main', config);
  assert.equal(listMemoryFiles('main', config).length, 0);
  // Operations on a group with no memory don't throw
  assert.equal(loadMemoryContext('ghost', config), '');
  assert.equal(searchMemory('ghost', 'x', config).length, 0);
  clearMemory('ghost', config);
});
