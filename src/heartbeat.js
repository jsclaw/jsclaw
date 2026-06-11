/**
 * Heartbeat — periodic agent wake-up for autonomous operation.
 *
 * Every interval, for each registered agent whose folder contains a
 * HEARTBEAT.md, the agent is woken with the file's tasks. If the agent
 * decides nothing needs doing it replies HEARTBEAT_OK and the output is
 * suppressed; anything else is delivered via the onAlert callback.
 * @module heartbeat
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createConfig } from './config.js';

export const HEARTBEAT_OK = 'HEARTBEAT_OK';

const HEARTBEAT_PROMPT = `[HEARTBEAT]
Read the tasks below (from HEARTBEAT.md) and check whether any of them need action right now.

- If nothing needs attention, reply with exactly: ${HEARTBEAT_OK}
- If something needs action, take it (use your tools), then summarize what you did.
- Do not pad your reply or explain that nothing happened — ${HEARTBEAT_OK} alone is the correct response for a routine check.

`;

/**
 * Check whether a time falls inside quiet hours.
 * @param {{ start: string, end: string }|undefined} quietHours - "HH:MM" strings
 * @param {Date} [now]
 * @returns {boolean}
 */
export function inQuietHours(quietHours, now = new Date()) {
  if (!quietHours?.start || !quietHours?.end) return false;
  const [sh, sm] = quietHours.start.split(':').map(Number);
  const [eh, em] = quietHours.end.split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  // Window may cross midnight (e.g. 22:00 - 07:00)
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

/**
 * @typedef {Object} HeartbeatDeps
 * @property {() => import('./types.js').AgentConfig[]} getAgents - Agents to check
 * @property {(agent: import('./types.js').AgentConfig, prompt: string) => Promise<import('./types.js').ContainerOutput>} runAgent
 *   Runs the agent for an agent (typically wraps runContainerAgent).
 * @property {(agent: import('./types.js').AgentConfig, result: string) => Promise<void>} [onAlert]
 *   Called when a heartbeat produces a non-OK result worth delivering.
 */

/**
 * @typedef {Object} HeartbeatOptions
 * @property {{ start: string, end: string }} [quietHours] - e.g. { start: '22:00', end: '07:00' }
 */

/**
 * Start the heartbeat loop.
 *
 * @param {HeartbeatDeps} deps
 * @param {import('./types.js').JsclawConfig} [config]
 * @param {HeartbeatOptions} [options]
 * @returns {{ stop: () => void, triggerNow: () => Promise<void> }}
 */
export function startHeartbeat(deps, config, options = {}) {
  config = config || createConfig();
  const log = config.logger;
  const { getAgents, runAgent, onAlert } = deps;

  /** Agent folders currently running a heartbeat. */
  const running = new Set();
  let stopped = false;

  async function beatAgent(agent) {
    const heartbeatPath = join(config.agentsDir, agent.folder, 'HEARTBEAT.md');
    if (!existsSync(heartbeatPath)) return;

    let tasks;
    try {
      tasks = readFileSync(heartbeatPath, 'utf-8').trim();
    } catch {
      return;
    }
    if (!tasks) return;

    if (running.has(agent.folder)) {
      log.debug(`Heartbeat skipped, previous still running`, { agent: agent.folder });
      return;
    }
    running.add(agent.folder);

    try {
      const output = await runAgent(agent, HEARTBEAT_PROMPT + tasks);
      const result = output?.result?.trim() || '';

      if (!result || result === HEARTBEAT_OK || result.startsWith(HEARTBEAT_OK)) {
        log.debug(`Heartbeat OK`, { agent: agent.folder });
        return;
      }

      log.info(`Heartbeat alert`, { agent: agent.folder });
      if (onAlert) await onAlert(agent, result);
    } catch (err) {
      log.error(`Heartbeat failed`, { agent: agent.folder, error: err.message });
    } finally {
      running.delete(agent.folder);
    }
  }

  async function beat({ ignoreQuietHours = false } = {}) {
    if (stopped) return;
    if (!ignoreQuietHours && inQuietHours(options.quietHours)) {
      log.debug('Heartbeat suppressed: quiet hours');
      return;
    }
    await Promise.all(getAgents().map(beatAgent));
  }

  const handle = setInterval(beat, config.heartbeatInterval);

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
    /** Trigger an immediate heartbeat cycle, bypassing quiet hours. */
    triggerNow: () => beat({ ignoreQuietHours: true }),
  };
}
