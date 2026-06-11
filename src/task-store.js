/**
 * JSON file-backed task persistence. Zero dependencies.
 * Tasks live in {dataDir}/tasks.json (atomic writes). After every
 * mutation a per-agent current_tasks.json snapshot is written into the
 * agent folder so the list_tasks MCP tool works inside containers.
 * @module task-store
 */

import {
  readFileSync, writeFileSync, renameSync, mkdirSync,
  openSync, writeSync, fsyncSync, closeSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConfig } from './config.js';
import { nextCron, isValidCron } from './cron.js';

/**
 * @typedef {Object} ScheduledTask
 * @property {string} id
 * @property {string} agentId - Agent whose container runs the task
 * @property {string} chatJid - Chat the task reports to
 * @property {string} prompt - Prompt to run when the task fires
 * @property {'cron'|'interval'|'once'} scheduleType
 * @property {string} scheduleValue - Cron expression, interval ms, or ISO date
 * @property {'fresh'|'resume'} contextMode
 * @property {'active'|'paused'|'completed'} status
 * @property {string|null} nextRun - ISO timestamp of next run
 * @property {string|null} lastRun - ISO timestamp of last run
 * @property {string} createdAt - ISO timestamp
 */

/**
 * Compute the next run time for a task.
 * @param {ScheduledTask} task
 * @param {Date} [from]
 * @returns {string|null} ISO timestamp, or null for completed one-shots
 */
export function computeNextRun(task, from = new Date()) {
  switch (task.scheduleType) {
    case 'cron':
      return nextCron(task.scheduleValue, from).toISOString();
    case 'interval': {
      const ms = Number(task.scheduleValue);
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error(`Invalid interval: ${task.scheduleValue}`);
      }
      return new Date(from.getTime() + ms).toISOString();
    }
    case 'once': {
      const when = new Date(task.scheduleValue);
      if (Number.isNaN(when.getTime())) {
        throw new Error(`Invalid date: ${task.scheduleValue}`);
      }
      // Already ran (or in the past at creation time, run asap)
      return task.lastRun ? null : when.toISOString();
    }
    default:
      throw new Error(`Unknown schedule type: ${task.scheduleType}`);
  }
}

export class TaskStore {
  /** @param {import('./types.js').JsclawConfig} [config] */
  constructor(config) {
    this._config = config || createConfig();
    this._path = join(this._config.dataDir, 'tasks.json');
    /** @type {ScheduledTask[]} */
    this._tasks = this._load();
  }

  /**
   * Load tasks from disk. A corrupt store file (torn write, stray edit,
   * wrong shape) is quarantined — never silently overwritten — and
   * reported at error level. A missing file is a normal first run.
   * @returns {ScheduledTask[]}
   */
  _load() {
    let raw;
    try {
      raw = readFileSync(this._path, 'utf-8');
    } catch {
      return []; // first run
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed)) return parsed;

    // Corrupt: preserve the evidence atomically, start empty, shout.
    const quarantine = `${this._path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      renameSync(this._path, quarantine);
    } catch {
      // If even the rename fails, refuse to lose the only copy silently:
      // leave the file in place; _save will still replace it, but the
      // error below gives the operator a chance to intervene.
    }
    this._config.logger.error(
      `tasks.json is corrupt — quarantined to ${quarantine}; starting with an empty task list`,
      { path: this._path }
    );
    return [];
  }

  _save() {
    mkdirSync(dirname(this._path), { recursive: true });
    const tmp = this._path + '.tmp';
    // Write + fsync the temp file before the atomic rename so an OS
    // crash can't leave a torn store file behind.
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(this._tasks, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this._path);
    this._writeSnapshots();
  }

  /** Write current_tasks.json into each agent folder that has tasks. */
  _writeSnapshots() {
    const byAgent = new Map();
    for (const task of this._tasks) {
      if (!byAgent.has(task.agentId)) byAgent.set(task.agentId, []);
      byAgent.get(task.agentId).push(task);
    }
    for (const [folder, tasks] of byAgent) {
      try {
        const dir = join(this._config.agentsDir, folder);
        mkdirSync(dir, { recursive: true });
        const snapshot = tasks.map((t) => ({
          id: t.id,
          prompt: t.prompt,
          schedule_type: t.scheduleType,
          schedule_value: t.scheduleValue,
          status: t.status,
          next_run: t.nextRun,
          last_run: t.lastRun,
        }));
        writeFileSync(join(dir, 'current_tasks.json'), JSON.stringify(snapshot, null, 2));
      } catch {
        // snapshot is best-effort
      }
    }
  }

  /**
   * Create a new scheduled task.
   * @param {{ agentId: string, chatJid: string, prompt: string, scheduleType: 'cron'|'interval'|'once', scheduleValue: string, contextMode?: 'fresh'|'resume' }} params
   * @returns {ScheduledTask}
   */
  createTask(params) {
    const { agentId, chatJid, prompt, scheduleType, scheduleValue, contextMode = 'fresh' } = params;

    if (!prompt) throw new Error('Task prompt is required');
    if (scheduleType === 'cron' && !isValidCron(scheduleValue)) {
      throw new Error(`Invalid cron expression: ${scheduleValue}`);
    }

    /** @type {ScheduledTask} */
    const task = {
      id: randomUUID().slice(0, 8),
      agentId,
      chatJid,
      prompt,
      scheduleType,
      scheduleValue,
      contextMode,
      status: 'active',
      nextRun: null,
      lastRun: null,
      createdAt: new Date().toISOString(),
    };
    task.nextRun = computeNextRun(task);

    this._tasks.push(task);
    this._save();
    return task;
  }

  /**
   * @param {string} id
   * @returns {ScheduledTask|undefined}
   */
  getTask(id) {
    return this._tasks.find((t) => t.id === id);
  }

  /**
   * @param {string} [agentId] - Filter by agent
   * @returns {ScheduledTask[]}
   */
  listTasks(agentId) {
    return agentId
      ? this._tasks.filter((t) => t.agentId === agentId)
      : [...this._tasks];
  }

  /**
   * Tasks that are due to run.
   * @param {Date} [now]
   * @returns {ScheduledTask[]}
   */
  getDueTasks(now = new Date()) {
    return this._tasks.filter(
      (t) => t.status === 'active' && t.nextRun && new Date(t.nextRun) <= now
    );
  }

  /**
   * Update task fields.
   * @param {string} id
   * @param {Partial<ScheduledTask>} fields
   * @returns {ScheduledTask|undefined}
   */
  updateTask(id, fields) {
    const task = this.getTask(id);
    if (!task) return undefined;
    Object.assign(task, fields);
    this._save();
    return task;
  }

  /**
   * Record a completed run and schedule the next one.
   * @param {string} id
   * @param {{ status?: 'success'|'error', error?: string }} [result]
   * @returns {ScheduledTask|undefined}
   */
  recordRun(id, result = {}) {
    const task = this.getTask(id);
    if (!task) return undefined;

    task.lastRun = new Date().toISOString();
    if (task.scheduleType === 'once') {
      task.status = 'completed';
      task.nextRun = null;
    } else {
      task.nextRun = computeNextRun(task);
    }
    if (result.error) task.lastError = result.error;
    this._save();
    return task;
  }

  /**
   * @param {string} id
   * @returns {boolean} Whether the task existed
   */
  deleteTask(id) {
    const idx = this._tasks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this._tasks.splice(idx, 1);
    this._save();
    return true;
  }
}

/**
 * Create an onTask handler for startIpcWatcher that wires the
 * schedule_task / pause_task / resume_task / cancel_task MCP tools
 * into a TaskStore — completing the in-container scheduling loop.
 *
 * Authorization: non-main agents may only manage their own tasks.
 *
 * @param {TaskStore} store
 * @param {{ logger?: import('./types.js').Logger }} [opts]
 * @returns {(type: string, data: Object, sourceAgent: string, isMain: boolean) => Promise<void>}
 */
export function createTaskIpcHandler(store, opts = {}) {
  const log = opts.logger;

  return async function onTask(type, data, sourceAgent, isMain) {
    switch (type) {
      case 'schedule_task': {
        const agentId = isMain && data.agent_folder ? data.agent_folder : sourceAgent;
        const task = store.createTask({
          agentId,
          chatJid: data.chat_jid,
          prompt: data.prompt,
          scheduleType: data.schedule_type,
          scheduleValue: data.schedule_value,
          contextMode: data.context_mode,
        });
        log?.info(`Task scheduled: ${task.id}`, { agentId, type: task.scheduleType });
        break;
      }
      case 'pause_task':
      case 'resume_task':
      case 'cancel_task': {
        const task = store.getTask(data.task_id);
        if (!task) {
          log?.warn(`Task not found: ${data.task_id}`);
          return;
        }
        if (!isMain && task.agentId !== sourceAgent) {
          log?.warn(`Agent ${sourceAgent} denied access to task ${data.task_id}`);
          return;
        }
        if (type === 'cancel_task') {
          store.deleteTask(task.id);
          log?.info(`Task cancelled: ${task.id}`);
        } else {
          const status = type === 'pause_task' ? 'paused' : 'active';
          const fields = { status };
          if (status === 'active') fields.nextRun = computeNextRun(task);
          store.updateTask(task.id, fields);
          log?.info(`Task ${status}: ${task.id}`);
        }
        break;
      }
      default:
        log?.warn(`Unknown task IPC type: ${type}`);
    }
  };
}
