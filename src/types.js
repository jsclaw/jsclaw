/**
 * JSDoc type definitions for jsclaw.
 * No runtime code - import for editor support.
 * @module types
 */

/**
 * @typedef {Object} ContainerInput
 * @property {string} prompt - The prompt/messages to send to the agent
 * @property {string} [sessionId] - Resume an existing Claude session
 * @property {string} agentId - Folder name for this agent's workspace
 * @property {string} chatJid - Identifier for the chat/conversation
 * @property {boolean} isMain - Whether this is the main/admin agent
 * @property {boolean} [isScheduledTask] - Whether this is a scheduled task invocation
 * @property {Record<string, Object>} [mcpServers] - MCP servers injected by the host (set automatically by runContainerAgent)
 * @property {string} [model] - Model for this run (input > agent > config precedence)
 * @property {string} [skillsIndex] - Description-driven skills index the
 *   runner appends to the system prompt (paths readable from inside the
 *   run: host paths in local mode, the read-only mount in containers)
 * @property {Record<string, string>} [providerEnv] - Provider credentials/endpoint injected by the host via stdin
 */

/**
 * @typedef {Object} ContainerOutput
 * @property {'success'|'error'} status
 * @property {string|null} result - The agent's response text
 * @property {string} [newSessionId] - Session ID for conversation continuity
 * @property {string} [error] - Error message if status is 'error'
 * @property {{input_tokens: number, output_tokens: number}} [usage] - Tokens
 *   consumed this turn, summed across the runner's API calls; cache
 *   reads/writes count as input
 */

/**
 * @typedef {Object} JsclawConfig
 * @property {string} containerImage - Docker image name (default: 'jsclaw-agent:latest')
 * @property {string} containerRuntime - Container engine for sandboxed runs:
 *   'docker' | 'podman' | 'container' (default: 'docker')
 * @property {string} sandboxMode - openclaw-style sandbox policy (default: 'auto'):
 *   'auto' (sandbox when the engine is available), 'all' (every agent in a
 *   container), 'non-main' (main agent on the host, others sandboxed),
 *   'off' (every agent as a plain process). Unsandboxed agents have NO
 *   isolation — they act as the host user. Per-agent AgentConfig.sandbox wins.
 * @property {string} [localRunner] - Runner entrypoint for unsandboxed runs
 *   (e.g. agent-micro's runner.js). Spawned with node; receives
 *   JSCLAW_WORKSPACE / JSCLAW_IPC_BASE instead of mounts.
 * @property {number} containerTimeout - Max container idle time in ms (default: 1800000)
 * @property {number} maxOutputSize - Max stdout buffer size in bytes (default: 10485760)
 * @property {number} maxConcurrentContainers - Concurrency limit (default: 5)
 * @property {number} ipcPollInterval - IPC polling interval in ms (default: 1000)
 * @property {number} schedulerPollInterval - Task scheduler poll interval in ms (default: 60000)
 * @property {number} heartbeatInterval - Heartbeat interval in ms (default: 1800000)
 * @property {string} dataDir - Base directory for IPC/data files
 * @property {string} agentsDir - Base directory for agent workspace folders
 * @property {string} skillsDir - Directory of SKILL.md files (default: ./skills)
 * @property {string} [configPath] - Explicit config file path (default: ./jsclaw.json or JSCLAW_CONFIG_PATH)
 * @property {string} [mountAllowlistPath] - Path to mount allowlist JSON
 * @property {number} [queueMaxRetries] - AgentQueue retry attempts (default: 5)
 * @property {number} [queueRetryBaseDelayMs] - AgentQueue base retry delay in ms (default: 5000)
 * @property {{ servers?: Record<string, Object> }} [mcp] - MCP servers for agents (openclaw's mcp.servers shape); passed to containers via stdin
 * @property {string} [model] - Default model for agents (e.g. 'claude-sonnet-4-6')
 * @property {string} [heartbeatModel] - Cheaper model for heartbeat cycles
 * @property {string} [providerBaseUrl] - Anthropic-compatible endpoint (GLM, Kimi, LiteLLM, ...)
 * @property {string} [providerAuthToken] - Bearer token for the endpoint (use ${ENV_VAR} in jsclaw.json)
 * @property {string} [gatewayToken] - Pinned gateway auth token
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
 * @typedef {Object} AgentConfig
 * @property {string} name - Display name of the agent
 * @property {string} folder - Folder name for workspace isolation
 * @property {string} [jid] - Chat identifier
 * @property {boolean} [isMain] - Whether this is the admin agent
 * @property {boolean} [sandbox] - Per-agent sandbox override: true forces a
 *   container, false forces a plain process. Unset = follow config.sandboxMode.
 * @property {VolumeMount[]} [additionalMounts] - Extra volume mounts
 * @property {Record<string, Object>} [mcpServers] - Per-agent MCP servers, merged over config.mcp.servers by name
 * @property {string} [model] - Model override for this agent
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
 * @typedef {Object} AgentState
 * @property {string} jid - Chat identifier
 * @property {import('node:child_process').ChildProcess|null} process - Active container process
 * @property {string|null} containerName - Name of the running container
 * @property {string|null} agentId - Folder name for this agent
 * @property {boolean} processing - Whether a message is being processed
 * @property {Array<{resolve: Function, reject: Function, fn?: Function, taskId?: string}>} queue - Pending work items
 */

/**
 * @typedef {Object} RegisteredAgent
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
 * @property {(type: string, data: Object, sourceAgent: string, isMain: boolean) => Promise<void>} onTask - Handle task IPC
 * @property {() => Record<string, RegisteredAgent>} getRegisteredAgents - Get registered agents
 */

export {};
