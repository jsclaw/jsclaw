/**
 * jsclaw - Lightweight container orchestration for Claude AI agents.
 * @module jsclaw
 */

// Config
export { createConfig, defaultConfig, loadConfigFile } from './config.js';

// Container runner
export {
  runContainerAgent,
  buildVolumeMounts,
  buildContainerArgs,
  parseContainerOutput,
  reapOrphanContainers,
  resolveMcpServers,
  writeTasksSnapshot,
} from './container-runner.js';

// IPC
export { startIpcWatcher } from './ipc.js';
export { writeIpcFile, readIpcFile, drainIpcDir, writeCloseSentinel } from './ipc-utils.js';

// Queue
export { AgentQueue } from './agent-queue.js';

// Scheduling
export { parseCron, isValidCron, nextCron } from './cron.js';
export { SessionStore } from './sessions.js';
export { TaskStore, computeNextRun, createTaskIpcHandler } from './task-store.js';
export { startTaskScheduler } from './task-scheduler.js';

// Heartbeat
export { startHeartbeat, inQuietHours, HEARTBEAT_OK } from './heartbeat.js';

// Channels
export { ChannelManager } from './channel.js';

// Gateway
export { startGateway } from './gateway.js';

// Providers
export { PROVIDERS, PROVIDER_ENV_KEYS, resolveProviderEnv } from './providers.js';

// Nostr
export {
  createNostrChannel,
  generatePrivateKey,
  getPublicKey,
  schnorrSign,
  schnorrVerify,
  nip04Encrypt,
  nip04Decrypt,
  finalizeEvent,
  verifyEvent,
  eventId,
  bech32Encode,
  bech32Decode,
} from './nostr.js';

// Webhooks
export { startWebhookIngress, renderTemplate, createWebhookEmitter } from './webhooks.js';

// Skills
export {
  parseFrontmatter,
  parseSkill,
  loadSkills,
  installSkill,
  removeSkill,
  skillMatches,
  matchSkills,
  buildSkillsIndex,
  buildSkillContext,
} from './skills.js';

// Multi-agent bindings
export { resolveBinding, resolveAgentConfig } from './bindings.js';

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
