/**
 * JSDoc type definitions for jsclaw.
 * No runtime code - import for editor support.
 * @module types
 */

/**
 * @typedef {Object} ContainerInput
 * @property {string} prompt - The prompt/messages to send to the agent
 * @property {string} [sessionId] - Resume an existing Claude session
 * @property {string} groupFolder - Folder name for this group's workspace
 * @property {string} chatJid - Identifier for the chat/conversation
 * @property {boolean} isMain - Whether this is the main/admin group
 * @property {boolean} [isScheduledTask] - Whether this is a scheduled task invocation
 */

/**
 * @typedef {Object} ContainerOutput
 * @property {'success'|'error'} status
 * @property {string|null} result - The agent's response text
 * @property {string} [newSessionId] - Session ID for conversation continuity
 * @property {string} [error] - Error message if status is 'error'
 */

/**
 * @typedef {Object} JsclawConfig
 * @property {string} containerImage - Docker image name (default: 'jsclaw-agent:latest')
 * @property {string} containerRuntime - 'docker' | 'podman' | 'container' (default: 'docker')
 * @property {number} containerTimeout - Max container idle time in ms (default: 1800000)
 * @property {number} maxOutputSize - Max stdout buffer size in bytes (default: 10485760)
 * @property {number} maxConcurrentContainers - Concurrency limit (default: 5)
 * @property {number} ipcPollInterval - IPC polling interval in ms (default: 1000)
 * @property {string} dataDir - Base directory for IPC/data files
 * @property {string} groupsDir - Base directory for group workspace folders
 * @property {string} [mountAllowlistPath] - Path to mount allowlist JSON
 * @property {Logger} [logger] - Logger instance (default: console-based)
 */

/**
 * @typedef {Object} Logger
 * @property {Function} debug
 * @property {Function} info
 * @property {Function} warn
 * @property {Function} error
 * @property {Function} fatal
 */

/**
 * @typedef {Object} GroupConfig
 * @property {string} name - Display name of the group
 * @property {string} folder - Folder name for workspace isolation
 * @property {string} [jid] - Chat identifier
 * @property {boolean} [isMain] - Whether this is the admin group
 * @property {VolumeMount[]} [additionalMounts] - Extra volume mounts
 */

/**
 * @typedef {Object} VolumeMount
 * @property {string} hostPath - Absolute path on the host
 * @property {string} containerPath - Path inside the container
 * @property {boolean} [readOnly] - Mount as read-only (default: false)
 */

/**
 * @typedef {Object} AdditionalMount
 * @property {string} host_path - Absolute path on the host
 * @property {string} container_path - Path inside the container
 * @property {boolean} [read_only] - Mount as read-only (default: false)
 */

/**
 * @typedef {Object} MountAllowlist
 * @property {string[]} allowed_roots - Allowed host path prefixes
 * @property {string[]} [blocked_patterns] - Glob patterns to block
 */

/**
 * @typedef {Object} GroupState
 * @property {string} jid - Chat identifier
 * @property {import('node:child_process').ChildProcess|null} process - Active container process
 * @property {string|null} containerName - Name of the running container
 * @property {string|null} groupFolder - Folder name for this group
 * @property {boolean} processing - Whether a message is being processed
 * @property {Array<{resolve: Function, reject: Function, fn?: Function, taskId?: string}>} queue - Pending work items
 */

/**
 * @typedef {Object} RegisteredGroup
 * @property {string} jid - Chat identifier
 * @property {string} name - Display name
 * @property {string} folder - Folder name
 * @property {string} [triggerPattern] - Pattern that triggers the agent
 * @property {boolean} [requiresTrigger] - Whether a trigger is needed
 */

/**
 * @typedef {Object} IpcMessage
 * @property {string} text - Message text to send
 * @property {string} [targetJid] - Override target chat
 * @property {string} [sender] - Sender name for multi-persona
 */

/**
 * @typedef {Object} IpcTask
 * @property {'schedule_task'|'pause_task'|'resume_task'|'cancel_task'} type
 * @property {Object} data - Task-specific payload
 */

/**
 * @typedef {Object} IpcDeps
 * @property {(jid: string, text: string, sender?: string) => Promise<void>} sendMessage - Send a message to a chat
 * @property {(type: string, data: Object, sourceGroup: string, isMain: boolean) => Promise<void>} onTask - Handle task IPC
 * @property {() => Record<string, RegisteredGroup>} getRegisteredGroups - Get registered groups
 */

export {};
