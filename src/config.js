/**
 * Configuration with defaults, optional jsclaw.json config file,
 * env var resolution, and explicit overrides.
 *
 * Precedence (openclaw convention, highest wins):
 *   explicit overrides > environment variables > config file > defaults
 *
 * The config file is ./jsclaw.json (or JSCLAW_CONFIG_PATH). Plain JSON;
 * ${ENV_VAR} references in string values are expanded.
 * @module config
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

/** @returns {import('./types.js').JsclawConfig} */
function defaults() {
  return {
    containerImage: 'jsclaw-agent:latest',
    containerRuntime: 'docker',
    localRunner: undefined,
    containerTimeout: 30 * 60 * 1000, // 30 minutes
    maxOutputSize: 10 * 1024 * 1024,  // 10 MB
    maxConcurrentContainers: 5,
    ipcPollInterval: 1000,
    schedulerPollInterval: 60 * 1000,   // 1 minute
    heartbeatInterval: 30 * 60 * 1000,  // 30 minutes
    dataDir: join(process.cwd(), 'data'),
    agentsDir: join(process.cwd(), 'agents'),
    skillsDir: join(process.cwd(), 'skills'),
    mountAllowlistPath: undefined,
    model: undefined,
    heartbeatModel: undefined,
    providerBaseUrl: undefined,
    providerAuthToken: undefined,
    gatewayToken: undefined,
    logger: undefined,
  };
}

/**
 * Expand ${ENV_VAR} in string values, recursively.
 * @param {*} value
 * @returns {*}
 */
function expandEnvRefs(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(expandEnvRefs);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnvRefs(v);
    return out;
  }
  return value;
}

/**
 * Load the config file if present.
 * @param {string} [explicitPath]
 * @returns {{ file: Object, path: string|null }}
 */
export function loadConfigFile(explicitPath) {
  const path = explicitPath || process.env.JSCLAW_CONFIG_PATH || join(process.cwd(), 'jsclaw.json');
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return { file: expandEnvRefs(parsed), path };
  } catch (err) {
    if (explicitPath || process.env.JSCLAW_CONFIG_PATH) {
      // An explicitly named config file that fails to load is an error
      if (err.code !== 'ENOENT') throw new Error(`Failed to load config file ${path}: ${err.message}`);
    }
    return { file: {}, path: null };
  }
}

/** Env var → config key mapping. */
const ENV_KEYS = {
  JSCLAW_CONTAINER_IMAGE: ['containerImage', String],
  JSCLAW_CONTAINER_RUNTIME: ['containerRuntime', String],
  JSCLAW_LOCAL_RUNNER: ['localRunner', String],
  JSCLAW_CONTAINER_TIMEOUT: ['containerTimeout', Number],
  JSCLAW_MAX_OUTPUT_SIZE: ['maxOutputSize', Number],
  JSCLAW_MAX_CONCURRENT: ['maxConcurrentContainers', Number],
  JSCLAW_IPC_POLL_INTERVAL: ['ipcPollInterval', Number],
  JSCLAW_SCHEDULER_POLL_INTERVAL: ['schedulerPollInterval', Number],
  JSCLAW_HEARTBEAT_INTERVAL: ['heartbeatInterval', Number],
  JSCLAW_DATA_DIR: ['dataDir', String],
  JSCLAW_AGENTS_DIR: ['agentsDir', String],
  JSCLAW_SKILLS_PATH: ['skillsDir', String],
  JSCLAW_MOUNT_ALLOWLIST: ['mountAllowlistPath', String],
  JSCLAW_MODEL: ['model', String],
  JSCLAW_HEARTBEAT_MODEL: ['heartbeatModel', String],
  JSCLAW_PROVIDER_BASE_URL: ['providerBaseUrl', String],
  JSCLAW_GATEWAY_TOKEN: ['gatewayToken', String],
};

/**
 * Create a config by merging defaults, config file, env vars, and overrides.
 * @param {Partial<import('./types.js').JsclawConfig>} [overrides]
 * @returns {import('./types.js').JsclawConfig}
 */
export function createConfig(overrides = {}) {
  const env = process.env;
  const { file } = loadConfigFile(overrides.configPath);

  const fromEnv = {};
  for (const [envName, [key, cast]] of Object.entries(ENV_KEYS)) {
    if (env[envName] !== undefined && env[envName] !== '') {
      fromEnv[key] = cast(env[envName]);
    }
  }

  const config = {
    ...defaults(),
    ...file,
    ...fromEnv,
    ...overrides,
  };

  if (!config.logger) {
    config.logger = createLogger({ level: env.JSCLAW_LOG_LEVEL || 'info' });
  }

  return config;
}

/** Default configuration instance. */
export const defaultConfig = createConfig();
