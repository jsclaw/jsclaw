import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../bin/jsclaw.js', import.meta.url).pathname;

function cliEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'jsclaw-cli-'));
  return {
    ...process.env,
    JSCLAW_DATA_DIR: join(dir, 'data'),
    JSCLAW_AGENTS_DIR: join(dir, 'agents'),
    JSCLAW_SKILLS_PATH: join(dir, 'skills'),
    JSCLAW_CONFIG_PATH: join(dir, 'jsclaw.json'),
    JSCLAW_LOG_LEVEL: 'info',
  };
}

test('jsclaw status runs', async () => {
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, 'status'], { env: cliEnv() }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout));
  });
  assert.match(out, /jsclaw v\d/);
});

// The gateway wires every subsystem together; a missing import only shows
// up when it boots. Start it on a random port, wait for "listening", stop.
test('jsclaw gateway boots and listens', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [CLI, 'gateway', '--port', String(port)], { env: cliEnv() });
  let log = '';
  const listening = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      log += chunk;
      if (log.includes('Gateway listening')) resolve();
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`gateway exited with ${code} before listening:\n${log}`)));
  });
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error(`gateway did not listen in time:\n${log}`)), 15000));
  try {
    await Promise.race([listening, timer]);
    // give the post-listen wiring (channels, scheduler, heartbeat) a moment to throw if it is going to
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(proc.exitCode, null, `gateway exited after listening:\n${log}`);
    assert.doesNotMatch(log, /is not defined|Cannot find|TypeError/, log);
  } finally {
    if (proc.exitCode === null) {
      const exited = new Promise((r) => proc.on('exit', r));
      proc.kill('SIGTERM');
      await exited;
    }
  }
});
