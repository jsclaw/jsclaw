/**
 * Per-group concurrency queue with global container limit.
 * Ensures only one container runs per group, with exponential backoff retry.
 * @module group-queue
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeIpcFile, writeCloseSentinel } from './ipc-utils.js';
import { createConfig } from './config.js';

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_DELAY = 5000;

/**
 * @typedef {Object} QueueItem
 * @property {Function} resolve
 * @property {Function} reject
 * @property {Function} [fn] - Custom processing function for tasks
 * @property {string} [taskId] - Task identifier
 */

export class GroupQueue {
  /** @param {import('./types.js').JsclawConfig} [config] */
  constructor(config) {
    this._config = config || createConfig();
    this._log = this._config.logger;
    this._maxRetries = this._config.queueMaxRetries ?? DEFAULT_MAX_RETRIES;
    this._retryBaseDelay = this._config.queueRetryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY;

    /** @type {Map<string, import('./types.js').GroupState>} */
    this._groups = new Map();

    /** @type {number} */
    this._activeCount = 0;

    /** @type {((groupJid: string) => Promise<boolean>)|null} */
    this._processMessagesFn = null;
  }

  /**
   * Set the function that processes messages for a group.
   * @param {(groupJid: string) => Promise<boolean>} fn
   */
  setProcessMessagesFn(fn) {
    this._processMessagesFn = fn;
  }

  /**
   * Get or create state for a group.
   * @param {string} jid
   * @returns {import('./types.js').GroupState}
   */
  _getGroup(jid) {
    if (!this._groups.has(jid)) {
      this._groups.set(jid, {
        jid,
        process: null,
        containerName: null,
        groupFolder: null,
        processing: false,
        queue: [],
      });
    }
    return this._groups.get(jid);
  }

  /**
   * Enqueue a message check for a group.
   * @param {string} groupJid
   * @returns {Promise<boolean>}
   */
  enqueueMessageCheck(groupJid) {
    return new Promise((resolve, reject) => {
      const group = this._getGroup(groupJid);
      group.queue.push({ resolve, reject });
      this._drain();
    });
  }

  /**
   * Enqueue a task with a custom processing function.
   * @param {string} groupJid
   * @param {string} taskId
   * @param {() => Promise<boolean>} fn
   * @returns {Promise<boolean>}
   */
  enqueueTask(groupJid, taskId, fn) {
    return new Promise((resolve, reject) => {
      const group = this._getGroup(groupJid);
      // Tasks go to the front of the queue (priority)
      group.queue.unshift({ resolve, reject, fn, taskId });
      this._drain();
    });
  }

  /**
   * Register an active container process for a group.
   * @param {string} groupJid
   * @param {import('node:child_process').ChildProcess} proc
   * @param {string} containerName
   * @param {string} groupFolder
   */
  registerProcess(groupJid, proc, containerName, groupFolder) {
    const group = this._getGroup(groupJid);
    group.process = proc;
    group.containerName = containerName;
    group.groupFolder = groupFolder;
  }

  /**
   * Send a message to an active container via IPC.
   * @param {string} groupJid
   * @param {string} text
   * @returns {boolean} Whether the message was delivered
   */
  sendMessage(groupJid, text) {
    const group = this._getGroup(groupJid);
    if (!group.process || !group.groupFolder) return false;

    const inputDir = join(this._config.dataDir, 'ipc', group.groupFolder, 'input');
    mkdirSync(inputDir, { recursive: true });
    writeIpcFile(inputDir, { text, timestamp: new Date().toISOString() });
    return true;
  }

  /**
   * Write close sentinel to signal a container to exit.
   * @param {string} groupJid
   */
  closeContainer(groupJid) {
    const group = this._getGroup(groupJid);
    if (!group.groupFolder) return;

    const inputDir = join(this._config.dataDir, 'ipc', group.groupFolder, 'input');
    writeCloseSentinel(inputDir);
  }

  /**
   * Try to process the next item in any group's queue.
   * @private
   */
  _drain() {
    // Fill every free slot; one pass may start several groups.
    for (const [, group] of this._groups) {
      if (this._activeCount >= this._config.maxConcurrentContainers) return;
      if (group.processing || group.queue.length === 0) continue;

      group.processing = true;
      this._activeCount++;

      const item = group.queue.shift();
      this._processItem(group, item);
    }
  }

  /**
   * Process a single queue item, retrying with exponential backoff.
   * The slot is held for the item's entire lifetime — including retries,
   * preserving per-group serialization — and released exactly once.
   * @param {import('./types.js').GroupState} group
   * @param {QueueItem} item
   * @private
   */
  async _processItem(group, item) {
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          let result;
          if (item.fn) {
            result = await item.fn();
          } else if (this._processMessagesFn) {
            result = await this._processMessagesFn(group.jid);
          } else {
            throw new Error('No processing function configured');
          }
          item.resolve(result);
          return;
        } catch (err) {
          if (attempt >= this._maxRetries) {
            this._log.error(`Failed after ${this._maxRetries} retries for group ${group.jid}`, {
              error: err.message,
            });
            item.reject(err);
            return;
          }
          const delay = this._retryBaseDelay * Math.pow(2, attempt);
          this._log.warn(`Retrying group ${group.jid} in ${delay}ms (attempt ${attempt + 1})`, {
            error: err.message,
          });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    } finally {
      group.processing = false;
      group.process = null;
      group.containerName = null;
      this._activeCount--;
      this._drain();
    }
  }

  /**
   * Check if a group has an active container.
   * @param {string} groupJid
   * @returns {boolean}
   */
  hasActiveContainer(groupJid) {
    const group = this._groups.get(groupJid);
    return !!(group?.process);
  }

  /**
   * Gracefully shut down all active containers.
   * @param {number} [gracePeriodMs=10000]
   */
  async shutdown(gracePeriodMs = 10000) {
    this._log.info(`Shutting down queue, ${this._activeCount} active containers`);

    // Signal all containers to close
    for (const [, group] of this._groups) {
      if (group.process && group.groupFolder) {
        this.closeContainer(group.jid);
      }
    }

    // Wait for grace period
    await new Promise((resolve) => setTimeout(resolve, gracePeriodMs));

    // Force kill remaining
    for (const [, group] of this._groups) {
      if (group.process) {
        try {
          group.process.kill('SIGKILL');
        } catch {
          // already dead
        }
      }
    }
  }
}
