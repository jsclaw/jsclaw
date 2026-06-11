/**
 * Per-agent concurrency queue with global container limit.
 * Ensures only one container runs per agent, with exponential backoff retry.
 * @module agent-queue
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

export class AgentQueue {
  /** @param {import('./types.js').JsclawConfig} [config] */
  constructor(config) {
    this._config = config || createConfig();
    this._log = this._config.logger;
    this._maxRetries = this._config.queueMaxRetries ?? DEFAULT_MAX_RETRIES;
    this._retryBaseDelay = this._config.queueRetryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY;

    /** @type {Map<string, import('./types.js').AgentState>} */
    this._agents = new Map();

    /** @type {number} */
    this._activeCount = 0;

    /** @type {((agentJid: string) => Promise<boolean>)|null} */
    this._processMessagesFn = null;
  }

  /**
   * Set the function that processes messages for an agent.
   * @param {(agentJid: string) => Promise<boolean>} fn
   */
  setProcessMessagesFn(fn) {
    this._processMessagesFn = fn;
  }

  /**
   * Get or create state for an agent.
   * @param {string} jid
   * @returns {import('./types.js').AgentState}
   */
  _getAgent(jid) {
    if (!this._agents.has(jid)) {
      this._agents.set(jid, {
        jid,
        process: null,
        containerName: null,
        agentId: null,
        processing: false,
        queue: [],
      });
    }
    return this._agents.get(jid);
  }

  /**
   * Enqueue a message check for an agent.
   * @param {string} agentJid
   * @returns {Promise<boolean>}
   */
  enqueueMessageCheck(agentJid) {
    return new Promise((resolve, reject) => {
      const agent = this._getAgent(agentJid);
      agent.queue.push({ resolve, reject });
      this._drain();
    });
  }

  /**
   * Enqueue a task with a custom processing function.
   * @param {string} agentJid
   * @param {string} taskId
   * @param {() => Promise<boolean>} fn
   * @returns {Promise<boolean>}
   */
  enqueueTask(agentJid, taskId, fn) {
    return new Promise((resolve, reject) => {
      const agent = this._getAgent(agentJid);
      // Tasks go to the front of the queue (priority)
      agent.queue.unshift({ resolve, reject, fn, taskId });
      this._drain();
    });
  }

  /**
   * Register an active container process for an agent.
   * @param {string} agentJid
   * @param {import('node:child_process').ChildProcess} proc
   * @param {string} containerName
   * @param {string} agentId
   */
  registerProcess(agentJid, proc, containerName, agentId) {
    const agent = this._getAgent(agentJid);
    agent.process = proc;
    agent.containerName = containerName;
    agent.agentId = agentId;
  }

  /**
   * Send a message to an active container via IPC.
   * @param {string} agentJid
   * @param {string} text
   * @returns {boolean} Whether the message was delivered
   */
  sendMessage(agentJid, text) {
    const agent = this._getAgent(agentJid);
    if (!agent.process || !agent.agentId) return false;

    const inputDir = join(this._config.dataDir, 'ipc', agent.agentId, 'input');
    mkdirSync(inputDir, { recursive: true });
    writeIpcFile(inputDir, { text, timestamp: new Date().toISOString() });
    return true;
  }

  /**
   * Write close sentinel to signal a container to exit.
   * @param {string} agentJid
   */
  closeContainer(agentJid) {
    const agent = this._getAgent(agentJid);
    if (!agent.agentId) return;

    const inputDir = join(this._config.dataDir, 'ipc', agent.agentId, 'input');
    writeCloseSentinel(inputDir);
  }

  /**
   * Try to process the next item in any agent's queue.
   * @private
   */
  _drain() {
    // Fill every free slot; one pass may start several agents.
    for (const [, agent] of this._agents) {
      if (this._activeCount >= this._config.maxConcurrentContainers) return;
      if (agent.processing || agent.queue.length === 0) continue;

      agent.processing = true;
      this._activeCount++;

      const item = agent.queue.shift();
      this._processItem(agent, item);
    }
  }

  /**
   * Process a single queue item, retrying with exponential backoff.
   * The slot is held for the item's entire lifetime — including retries,
   * preserving per-agent serialization — and released exactly once.
   * @param {import('./types.js').AgentState} agent
   * @param {QueueItem} item
   * @private
   */
  async _processItem(agent, item) {
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          let result;
          if (item.fn) {
            result = await item.fn();
          } else if (this._processMessagesFn) {
            result = await this._processMessagesFn(agent.jid);
          } else {
            throw new Error('No processing function configured');
          }
          item.resolve(result);
          return;
        } catch (err) {
          if (attempt >= this._maxRetries) {
            this._log.error(`Failed after ${this._maxRetries} retries for agent ${agent.jid}`, {
              error: err.message,
            });
            item.reject(err);
            return;
          }
          const delay = this._retryBaseDelay * Math.pow(2, attempt);
          this._log.warn(`Retrying agent ${agent.jid} in ${delay}ms (attempt ${attempt + 1})`, {
            error: err.message,
          });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    } finally {
      agent.processing = false;
      agent.process = null;
      agent.containerName = null;
      this._activeCount--;
      this._drain();
    }
  }

  /**
   * Check if an agent has an active container.
   * @param {string} agentJid
   * @returns {boolean}
   */
  hasActiveContainer(agentJid) {
    const agent = this._agents.get(agentJid);
    return !!(agent?.process);
  }

  /**
   * Gracefully shut down all active containers.
   * @param {number} [gracePeriodMs=10000]
   */
  async shutdown(gracePeriodMs = 10000) {
    this._log.info(`Shutting down queue, ${this._activeCount} active containers`);

    // Signal all containers to close
    for (const [, agent] of this._agents) {
      if (agent.process && agent.agentId) {
        this.closeContainer(agent.jid);
      }
    }

    // Wait for grace period
    await new Promise((resolve) => setTimeout(resolve, gracePeriodMs));

    // Force kill remaining
    for (const [, agent] of this._agents) {
      if (agent.process) {
        try {
          agent.process.kill('SIGKILL');
        } catch {
          // already dead
        }
      }
    }
  }
}
