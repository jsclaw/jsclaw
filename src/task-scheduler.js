/**
 * Task scheduler. Polls a TaskStore for due tasks and executes them
 * through a consumer-provided runner (typically wrapping runContainerAgent,
 * optionally via a AgentQueue).
 * @module task-scheduler
 */

import { createConfig } from './config.js';

/**
 * @typedef {Object} SchedulerDeps
 * @property {import('./task-store.js').TaskStore} store
 * @property {(task: import('./task-store.js').ScheduledTask) => Promise<void>} runTask
 *   Executes one task. Throwing marks the run as an error; the task is
 *   rescheduled either way (one-shots complete).
 */

/**
 * Start the scheduler loop.
 *
 * @param {SchedulerDeps} deps
 * @param {import('./types.js').JsclawConfig} [config]
 * @returns {{ stop: () => void, tick: () => Promise<void> }}
 */
export function startTaskScheduler(deps, config) {
  config = config || createConfig();
  const log = config.logger;
  const { store, runTask } = deps;

  /** Task ids currently executing, so a slow run isn't double-fired. */
  const running = new Set();
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const due = store.getDueTasks();

    for (const task of due) {
      if (running.has(task.id)) continue;
      running.add(task.id);

      const startedAt = Date.now();
      log.info(`Running task ${task.id}`, { agent: task.agentId });

      // Fire-and-forget so one long task doesn't block the rest
      runTask(task)
        .then(() => {
          store.recordRun(task.id, { status: 'success' });
          log.info(`Task ${task.id} completed`, { durationMs: Date.now() - startedAt });
        })
        .catch((err) => {
          store.recordRun(task.id, { status: 'error', error: err.message });
          log.error(`Task ${task.id} failed`, { error: err.message });
        })
        .finally(() => {
          running.delete(task.id);
        });
    }
  }

  const handle = setInterval(tick, config.schedulerPollInterval);
  tick();

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
    tick,
  };
}
