/**
 * jsclaw - Lightweight container orchestration for Claude AI agents.
 * @module jsclaw
 */

// Config
export { createConfig, defaultConfig } from './config.js';

// Container runner
export {
  runContainerAgent,
  buildVolumeMounts,
  buildContainerArgs,
  parseContainerOutput,
  writeTasksSnapshot,
} from './container-runner.js';

// IPC
export { startIpcWatcher } from './ipc.js';
export { writeIpcFile, readIpcFile, drainIpcDir, writeCloseSentinel } from './ipc-utils.js';

// Queue
export { GroupQueue } from './group-queue.js';

// Security
export {
  validateMount,
  validateAdditionalMounts,
  loadMountAllowlist,
  generateAllowlistTemplate,
} from './mount-security.js';

// Logger
export { createLogger } from './logger.js';
