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

// Scheduling
export { parseCron, isValidCron, nextCron } from './cron.js';
export { TaskStore, computeNextRun, createTaskIpcHandler } from './task-store.js';
export { startTaskScheduler } from './task-scheduler.js';

// Heartbeat
export { startHeartbeat, inQuietHours, HEARTBEAT_OK } from './heartbeat.js';

// Channels
export { ChannelManager } from './channel.js';

// Webhooks
export { startWebhookIngress, renderTemplate } from './webhooks.js';

// Memory
export {
  MEMORY_CATEGORIES,
  memoryDir,
  initMemory,
  listMemoryFiles,
  loadMemoryContext,
  appendMemory,
  searchMemory,
  clearMemory,
} from './memory.js';

// Security
export {
  validateMount,
  validateAdditionalMounts,
  loadMountAllowlist,
  generateAllowlistTemplate,
} from './mount-security.js';

// Logger
export { createLogger } from './logger.js';
