/**
 * Configuration with defaults and env var resolution.
 * @module config
 */

import { join } from 'node:path';
import { createLogger } from './logger.js';

/** @type {import('./types.js').JsclawConfig} */
const DEFAULTS = {
  containerImage: 'jsclaw-agent:latest',
  containerRuntime: 'docker',
  containerTimeout: 30 * 60 * 1000, // 30 minutes
  maxOutputSize: 10 * 1024 * 1024,  // 10 MB
  maxConcurrentContainers: 5,
  ipcPollInterval: 1000,
  dataDir: join(process.cwd(), 'data'),
  groupsDir: join(process.cwd(), 'groups'),
  mountAllowlistPath: undefined,
  logger: undefined,
};

/**
 * Create a config by merging defaults, env vars, and overrides.
 * @param {Partial<import('./types.js').JsclawConfig>} [overrides]
 * @returns {import('./types.js').JsclawConfig}
 */
export function createConfig(overrides = {}) {
  const env = process.env;

  const config = {
    ...DEFAULTS,
    // Env var overrides
    ...(env.JSCLAW_CONTAINER_IMAGE && { containerImage: env.JSCLAW_CONTAINER_IMAGE }),
    ...(env.JSCLAW_CONTAINER_RUNTIME && { containerRuntime: env.JSCLAW_CONTAINER_RUNTIME }),
    ...(env.JSCLAW_CONTAINER_TIMEOUT && { containerTimeout: Number(env.JSCLAW_CONTAINER_TIMEOUT) }),
    ...(env.JSCLAW_MAX_OUTPUT_SIZE && { maxOutputSize: Number(env.JSCLAW_MAX_OUTPUT_SIZE) }),
    ...(env.JSCLAW_MAX_CONCURRENT && { maxConcurrentContainers: Number(env.JSCLAW_MAX_CONCURRENT) }),
    ...(env.JSCLAW_IPC_POLL_INTERVAL && { ipcPollInterval: Number(env.JSCLAW_IPC_POLL_INTERVAL) }),
    ...(env.JSCLAW_DATA_DIR && { dataDir: env.JSCLAW_DATA_DIR }),
    ...(env.JSCLAW_GROUPS_DIR && { groupsDir: env.JSCLAW_GROUPS_DIR }),
    ...(env.JSCLAW_MOUNT_ALLOWLIST && { mountAllowlistPath: env.JSCLAW_MOUNT_ALLOWLIST }),
    // Explicit overrides take precedence
    ...overrides,
  };

  if (!config.logger) {
    config.logger = createLogger({ level: env.JSCLAW_LOG_LEVEL || 'info' });
  }

  return config;
}

/** Default configuration instance. */
export const defaultConfig = createConfig();
