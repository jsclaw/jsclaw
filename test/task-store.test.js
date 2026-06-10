import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore, createTaskIpcHandler } from '../src/task-store.js';
import { startTaskScheduler } from '../src/task-scheduler.js';
import { tempConfig } from './helpers.js';

test('creates, persists, and snapshots tasks', () => {
  const config = tempConfig();
  const store = new TaskStore(config);

  const task = store.createTask({
    groupFolder: 'main', chatJid: 'c1', prompt: 'check weather',
    scheduleType: 'interval', scheduleValue: '60000',
  });
  assert.ok(task.id);
  assert.equal(task.status, 'active');
  assert.ok(task.nextRun);

  // Snapshot for list_tasks MCP tool
  const snapshot = JSON.parse(
    readFileSync(join(config.groupsDir, 'main', 'current_tasks.json'), 'utf-8')
  );
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].schedule_type, 'interval');

  // Persistence across instances
  const store2 = new TaskStore(config);
  assert.equal(store2.listTasks().length, 1);
});

test('rejects invalid cron and empty prompts', () => {
  const store = new TaskStore(tempConfig());
  assert.throws(() => store.createTask({
    groupFolder: 'g', chatJid: 'c', prompt: 'x',
    scheduleType: 'cron', scheduleValue: 'bad cron',
  }));
  assert.throws(() => store.createTask({
    groupFolder: 'g', chatJid: 'c', prompt: '',
    scheduleType: 'once', scheduleValue: new Date().toISOString(),
  }));
});

test('getDueTasks respects status and nextRun', () => {
  const store = new TaskStore(tempConfig());
  const past = store.createTask({
    groupFolder: 'g', chatJid: 'c', prompt: 'due',
    scheduleType: 'once', scheduleValue: new Date(Date.now() - 1000).toISOString(),
  });
  store.createTask({
    groupFolder: 'g', chatJid: 'c', prompt: 'future',
    scheduleType: 'once', scheduleValue: new Date(Date.now() + 1e7).toISOString(),
  });
  const due = store.getDueTasks();
  assert.equal(due.length, 1);
  assert.equal(due[0].id, past.id);

  store.updateTask(past.id, { status: 'paused' });
  assert.equal(store.getDueTasks().length, 0);
});

test('recordRun completes one-shots and reschedules intervals', () => {
  const store = new TaskStore(tempConfig());
  const once = store.createTask({
    groupFolder: 'g', chatJid: 'c', prompt: 'once',
    scheduleType: 'once', scheduleValue: new Date(Date.now() - 1000).toISOString(),
  });
  store.recordRun(once.id);
  assert.equal(store.getTask(once.id).status, 'completed');
  assert.equal(store.getTask(once.id).nextRun, null);

  const interval = store.createTask({
    groupFolder: 'g', chatJid: 'c', prompt: 'rep',
    scheduleType: 'interval', scheduleValue: '60000',
  });
  store.recordRun(interval.id);
  const after = store.getTask(interval.id);
  assert.equal(after.status, 'active');
  assert.ok(after.lastRun, 'lastRun recorded');
  // Next run is rescheduled one interval after the run
  assert.ok(new Date(after.nextRun) - new Date(after.lastRun) >= 60000);
});

test('IPC handler enforces authorization', async () => {
  const store = new TaskStore(tempConfig());
  const onTask = createTaskIpcHandler(store);

  await onTask('schedule_task', {
    prompt: 'p', schedule_type: 'interval', schedule_value: '9999999', chat_jid: 'c',
  }, 'group-a', false);
  const task = store.listTasks('group-a')[0];
  assert.ok(task);

  // Another non-main group cannot cancel it
  await onTask('cancel_task', { task_id: task.id }, 'group-b', false);
  assert.ok(store.getTask(task.id));

  // Main can pause/resume/cancel anything
  await onTask('pause_task', { task_id: task.id }, 'main', true);
  assert.equal(store.getTask(task.id).status, 'paused');
  await onTask('resume_task', { task_id: task.id }, 'main', true);
  assert.equal(store.getTask(task.id).status, 'active');
  await onTask('cancel_task', { task_id: task.id }, 'main', true);
  assert.equal(store.getTask(task.id), undefined);
});

test('scheduler runs due tasks exactly once and repeats intervals', async () => {
  const config = tempConfig({ schedulerPollInterval: 50 });
  const store = new TaskStore(config);
  const once = store.createTask({
    groupFolder: 'g', chatJid: 'c', prompt: 'once',
    scheduleType: 'once', scheduleValue: new Date(Date.now() - 1000).toISOString(),
  });
  const interval = store.createTask({
    groupFolder: 'g', chatJid: 'c', prompt: 'rep',
    scheduleType: 'interval', scheduleValue: '30',
  });

  const ran = [];
  const sched = startTaskScheduler({
    store,
    runTask: async (t) => { ran.push(t.id); },
  }, config);

  await new Promise((r) => setTimeout(r, 300));
  sched.stop();

  assert.equal(ran.filter((id) => id === once.id).length, 1);
  assert.equal(store.getTask(once.id).status, 'completed');
  assert.ok(ran.filter((id) => id === interval.id).length >= 2);
});

test('scheduler records failures without stopping', async () => {
  const config = tempConfig({ schedulerPollInterval: 50 });
  const store = new TaskStore(config);
  const bad = store.createTask({
    groupFolder: 'g', chatJid: 'c', prompt: 'fails',
    scheduleType: 'once', scheduleValue: new Date(Date.now() - 1000).toISOString(),
  });

  const sched = startTaskScheduler({
    store,
    runTask: async () => { throw new Error('boom'); },
  }, config);
  await new Promise((r) => setTimeout(r, 200));
  sched.stop();

  const after = store.getTask(bad.id);
  assert.equal(after.status, 'completed'); // once-task completes even on error
  assert.equal(after.lastError, 'boom');
});

test('corrupt tasks.json is quarantined, not silently wiped', () => {
  const config = tempConfig();
  const errors = [];
  config.logger = { ...config.logger, error: (msg, data) => errors.push({ msg, data }) };

  // Simulate a torn write / stray edit
  mkdirSync(config.dataDir, { recursive: true });
  const storePath = join(config.dataDir, 'tasks.json');
  writeFileSync(storePath, '{ "tasks": [ TORN');

  const store = new TaskStore(config);
  assert.deepEqual(store.listTasks(), [], 'store starts empty after corruption');

  // The corruption was reported loudly
  assert.equal(errors.length, 1, 'an error was logged');
  assert.match(errors[0].msg, /corrupt/i);

  // The evidence was preserved
  const quarantined = readdirSync(config.dataDir).filter((n) => /^tasks\.json\.corrupt-/.test(n));
  assert.equal(quarantined.length, 1, 'corrupt file quarantined');
  assert.equal(
    readFileSync(join(config.dataDir, quarantined[0]), 'utf-8'),
    '{ "tasks": [ TORN',
    'original bytes intact'
  );

  // A subsequent save writes fresh state without touching the evidence
  store.createTask({
    groupFolder: 'g', chatJid: 'c', prompt: 'recovered',
    scheduleType: 'interval', scheduleValue: '60000',
  });
  const fresh = JSON.parse(readFileSync(storePath, 'utf-8'));
  assert.equal(fresh.length, 1);
  assert.equal(
    readFileSync(join(config.dataDir, quarantined[0]), 'utf-8'),
    '{ "tasks": [ TORN',
    'quarantined evidence untouched by saves'
  );
});

test('valid-JSON-but-wrong-shape is quarantined too', () => {
  const config = tempConfig();
  const errors = [];
  config.logger = { ...config.logger, error: (msg) => errors.push(msg) };

  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(join(config.dataDir, 'tasks.json'), '{"not":"an array"}');

  const store = new TaskStore(config);
  assert.deepEqual(store.listTasks(), []);
  assert.equal(errors.length, 1);
  assert.equal(
    readdirSync(config.dataDir).filter((n) => /^tasks\.json\.corrupt-/.test(n)).length,
    1
  );
});

test('missing tasks.json is a normal first run: no quarantine, no error', () => {
  const config = tempConfig();
  const errors = [];
  config.logger = { ...config.logger, error: (msg) => errors.push(msg) };

  const store = new TaskStore(config);
  assert.deepEqual(store.listTasks(), []);
  assert.equal(errors.length, 0);
});
