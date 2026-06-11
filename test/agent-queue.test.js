import { test } from 'node:test';
import assert from 'node:assert';
import { AgentQueue } from '../src/agent-queue.js';
import { tempConfig } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fail the test if a promise doesn't settle in time — deadlock detector. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    sleep(ms).then(() => { throw new Error(`deadlock: ${label} did not settle within ${ms}ms`); }),
  ]);
}

function queueConfig(overrides = {}) {
  return tempConfig({
    maxConcurrentContainers: 2,
    queueRetryBaseDelayMs: 10, // keep retry tests fast
    ...overrides,
  });
}

test('successful tasks release their slots (no deadlock after N tasks)', async () => {
  const queue = new AgentQueue(queueConfig({ maxConcurrentContainers: 1 }));
  const ran = [];

  // With a global cap of 1, the third task only runs if the first two
  // released their slots. Broken accounting deadlocks here.
  await withTimeout(queue.enqueueTask('g1', 't1', async () => { ran.push('t1'); return true; }), 2000, 't1');
  await withTimeout(queue.enqueueTask('g2', 't2', async () => { ran.push('t2'); return true; }), 2000, 't2');
  await withTimeout(queue.enqueueTask('g3', 't3', async () => { ran.push('t3'); return true; }), 2000, 't3');

  assert.deepEqual(ran, ['t1', 't2', 't3']);
  assert.equal(queue._activeCount, 0, 'all slots released');
});

test('same agent runs queued tasks sequentially, both complete', async () => {
  const queue = new AgentQueue(queueConfig());
  const order = [];

  const p1 = queue.enqueueTask('g1', 'a', async () => { order.push('a-start'); await sleep(50); order.push('a-end'); return true; });
  const p2 = queue.enqueueTask('g1', 'b', async () => { order.push('b-start'); return true; });

  await withTimeout(Promise.all([p1, p2]), 2000, 'same-agent tasks');
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start'], 'serialized, no overlap');
  assert.equal(queue._activeCount, 0);
});

test('message retry path keeps accounting consistent', async () => {
  const queue = new AgentQueue(queueConfig());
  let calls = 0;
  queue.setProcessMessagesFn(async () => {
    calls++;
    if (calls < 3) throw new Error('transient');
    return true;
  });

  const result = await withTimeout(queue.enqueueMessageCheck('g1'), 5000, 'retried message');
  assert.equal(result, true);
  assert.equal(calls, 3, 'failed twice, succeeded third');
  assert.equal(queue._activeCount, 0, 'released exactly once, not per attempt');

  // Queue must still be usable afterwards
  await withTimeout(queue.enqueueMessageCheck('g1'), 2000, 'subsequent message');
  assert.equal(queue._activeCount, 0);
});

test('slot stays held during retries (no concurrent run of the same agent)', async () => {
  const queue = new AgentQueue(queueConfig({ maxConcurrentContainers: 1 }));
  let active = 0;
  let peak = 0;
  let calls = 0;
  queue.setProcessMessagesFn(async () => {
    active++; peak = Math.max(peak, active);
    await sleep(20);
    active--;
    calls++;
    if (calls === 1) throw new Error('first attempt fails');
    return true;
  });

  // Second check enqueued while the first is mid-retry
  const p1 = queue.enqueueMessageCheck('g1');
  await sleep(5);
  const p2 = queue.enqueueMessageCheck('g1');

  await withTimeout(Promise.all([p1, p2]), 5000, 'retry overlap');
  assert.equal(peak, 1, 'the agent never ran concurrently with itself');
  assert.equal(queue._activeCount, 0);
});

test('exhausted retries reject and release the slot', async () => {
  const queue = new AgentQueue(queueConfig({ queueMaxRetries: 1 }));
  queue.setProcessMessagesFn(async () => { throw new Error('permanent'); });

  await assert.rejects(
    withTimeout(queue.enqueueMessageCheck('g1'), 5000, 'failing message'),
    /permanent/
  );
  assert.equal(queue._activeCount, 0, 'slot released after final failure');

  // Still usable
  queue.setProcessMessagesFn(async () => true);
  await withTimeout(queue.enqueueMessageCheck('g1'), 2000, 'recovery message');
});

test('global concurrency cap holds across agents', async () => {
  const queue = new AgentQueue(queueConfig({ maxConcurrentContainers: 2 }));
  let active = 0;
  let peak = 0;
  const work = async () => {
    active++; peak = Math.max(peak, active);
    await sleep(40);
    active--;
    return true;
  };

  await withTimeout(Promise.all([
    queue.enqueueTask('g1', 't1', work),
    queue.enqueueTask('g2', 't2', work),
    queue.enqueueTask('g3', 't3', work),
    queue.enqueueTask('g4', 't4', work),
  ]), 4000, 'capped tasks');

  assert.equal(peak, 2, 'never more than maxConcurrentContainers in flight');
  assert.equal(queue._activeCount, 0);
});

test('tasks are prioritized ahead of queued messages in the same agent', async () => {
  const queue = new AgentQueue(queueConfig({ maxConcurrentContainers: 1 }));
  const order = [];
  queue.setProcessMessagesFn(async () => { order.push('message'); return true; });

  // Occupy the only slot so both items queue up behind it
  const blocker = queue.enqueueTask('g0', 'blocker', async () => { await sleep(40); return true; });
  await sleep(5);
  const msg = queue.enqueueMessageCheck('g1');
  const task = queue.enqueueTask('g1', 'priority', async () => { order.push('task'); return true; });

  await withTimeout(Promise.all([blocker, msg, task]), 3000, 'priority drain');
  assert.deepEqual(order, ['task', 'message']);
});
