import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIpcFile, readIpcFile, drainIpcDir, writeCloseSentinel } from '../src/ipc-utils.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'jsclaw-ipc-'));
}

test('writeIpcFile creates parseable files, no temp residue', () => {
  const dir = tempDir();
  const path = writeIpcFile(dir, { hello: 'world' });
  assert.ok(path.endsWith('.json'));
  assert.deepEqual(readIpcFile(path), { hello: 'world' });
  // No .tmp files left behind
  assert.ok(readdirSync(dir).every((n) => !n.endsWith('.tmp')));
});

test('drainIpcDir returns sorted entries and deletes them', () => {
  const dir = tempDir();
  writeIpcFile(dir, { n: 1 });
  writeIpcFile(dir, { n: 2 });
  writeFileSync(join(dir, 'not-json.txt'), 'ignore me');
  writeFileSync(join(dir, '.hidden.json.tmp'), '{}'); // temp-style file ignored

  const drained = drainIpcDir(dir);
  assert.equal(drained.length, 2);
  assert.deepEqual(drained.map((d) => d.data.n), [1, 2]);

  // JSON files consumed, others untouched
  const left = readdirSync(dir);
  assert.ok(left.includes('not-json.txt'));
  assert.equal(left.filter((n) => n.endsWith('.json')).length, 0);

  // Second drain is empty
  assert.equal(drainIpcDir(dir).length, 0);
});

test('drainIpcDir skips malformed JSON without throwing', () => {
  const dir = tempDir();
  writeFileSync(join(dir, '0-bad.json'), '{ nope');
  writeIpcFile(dir, { ok: true });
  const drained = drainIpcDir(dir);
  assert.equal(drained.length, 1);
  assert.equal(drained[0].data.ok, true);
});

test('drainIpcDir on a missing directory returns []', () => {
  assert.deepEqual(drainIpcDir('/nonexistent/dir'), []);
});

test('writeCloseSentinel creates the _close file', () => {
  const dir = join(tempDir(), 'input');
  writeCloseSentinel(dir);
  assert.ok(existsSync(join(dir, '_close')));
});
