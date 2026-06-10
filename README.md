# jsclaw

Lightweight container orchestration for Claude AI agents. Pure JavaScript ESM, zero host-side dependencies.

A JavaScript port of [nanoclaw](https://github.com/qwibitai/nanoclaw) — the core engine without the channel-specific code.

## What is jsclaw?

jsclaw provides primitives for running Claude AI agents in isolated Docker containers:

- **Container Runner** — Spawn Docker containers, stream agent output via sentinel-delimited JSON
- **IPC System** — Filesystem-based JSON communication between host and container
- **Group Queue** — Per-group concurrency with configurable container limits
- **MCP Tools** — Send messages and schedule tasks from inside the agent
- **Task Scheduler** — Cron, interval, and one-shot tasks with zero-dep cron parsing
- **Heartbeat** — Periodic agent wake-up for autonomous operation (`HEARTBEAT.md`)
- **Identity Files** — `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`, `USER.md` loaded into the system prompt, openclaw-style
- **Channels** — Formal `Channel` interface + `ChannelManager` routing for pluggable I/O
- **Mount Security** — Validate volume mounts against allowlists

You bring your own I/O (chat, API, CLI) and storage. jsclaw handles the container orchestration.

## Install

```
npm install jsclaw
```

## Quick Start

### 1. Build the container image

```bash
docker build -t jsclaw-agent:latest -f node_modules/jsclaw/container/Dockerfile node_modules/jsclaw/container/
```

### 2. Run an agent

```javascript
import { runContainerAgent, createConfig } from 'jsclaw';

const config = createConfig({
  containerImage: 'jsclaw-agent:latest',
  dataDir: './data',
  groupsDir: './groups',
});

const group = { name: 'my-agent', folder: 'my-agent' };
const input = {
  prompt: 'Hello, what can you do?',
  groupFolder: 'my-agent',
  chatJid: 'user-1',
  isMain: true,
};

const result = await runContainerAgent(
  group,
  input,
  (proc, name) => console.log(`Container ${name} started`),
  async (output) => console.log('Agent:', output.result),
  config,
);
```

### 3. With Queue + IPC

```javascript
import { GroupQueue, startIpcWatcher, createConfig } from 'jsclaw';

const config = createConfig();
const queue = new GroupQueue(config);

queue.setProcessMessagesFn(async (groupJid) => {
  // Your logic: fetch messages, run agent, handle output
  return true;
});

const ipc = startIpcWatcher({
  sendMessage: async (jid, text) => {
    // Send text via your channel
  },
  onTask: async (type, data, sourceGroup, isMain) => {
    // Handle schedule_task, pause_task, etc.
  },
  getRegisteredGroups: () => ({}),
}, config);

// Trigger processing
queue.enqueueMessageCheck('group-1');

// Cleanup
// ipc.stop();
// await queue.shutdown();
```

### 4. Scheduled tasks + heartbeat (autonomous operation)

```javascript
import {
  TaskStore, createTaskIpcHandler, startTaskScheduler,
  startHeartbeat, runContainerAgent, startIpcWatcher, createConfig,
} from 'jsclaw';

const config = createConfig();
const store = new TaskStore(config);

// Agents can now schedule their own tasks via the schedule_task MCP tool
startIpcWatcher({
  sendMessage: async (jid, text) => { /* your channel */ },
  onTask: createTaskIpcHandler(store),
  getRegisteredGroups: () => ({}),
}, config);

// Execute due tasks (cron / interval / once)
startTaskScheduler({
  store,
  runTask: async (task) => {
    await runContainerAgent(
      { name: task.groupFolder, folder: task.groupFolder },
      { prompt: task.prompt, groupFolder: task.groupFolder,
        chatJid: task.chatJid, isMain: true, isScheduledTask: true },
      null, null, config,
    );
  },
}, config);

// Wake agents periodically to check their HEARTBEAT.md
startHeartbeat({
  getGroups: () => [{ name: 'main', folder: 'main' }],
  runAgent: (group, prompt) => runContainerAgent(
    group,
    { prompt, groupFolder: group.folder, chatJid: 'heartbeat', isMain: true },
    null, null, config,
  ),
  onAlert: async (group, result) => { /* deliver via your channel */ },
}, config, { quietHours: { start: '22:00', end: '07:00' } });
```

Drop a `HEARTBEAT.md` in a group folder to give that agent standing tasks:

```markdown
## Every heartbeat
- Check for failed deployments, alert me if any

## Daily (morning)
- Summarize my calendar for the day
```

The agent replies `HEARTBEAT_OK` when nothing needs attention (suppressed); anything else is delivered through `onAlert`.

### 5. Identity files (personality)

Drop any of `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`, `USER.md` into a group folder and the agent loads them into its system prompt in that order — same convention as openclaw:

```markdown
<!-- groups/main/SOUL.md -->
# SOUL.md
You are the colleague who actually gets things done.

## Boundaries
- Don't pad replies. Skip "Great question!" — just help.
```

### 6. Channels (pluggable I/O)

```javascript
import { ChannelManager, TaskStore, createTaskIpcHandler, startIpcWatcher, createConfig } from 'jsclaw';

const store = new TaskStore(createConfig());
const channels = new ChannelManager();
channels.register(myTelegramChannel);   // implements the Channel interface
channels.register(myDiscordChannel);

await channels.connectAll();

// Outbound routing by JID — drops straight into the IPC watcher
startIpcWatcher({
  sendMessage: channels.sendMessage,
  onTask: createTaskIpcHandler(store),
  getRegisteredGroups: () => ({}),
}, createConfig());
```

A `Channel` implements: `name`, `connect()`, `disconnect()`, `sendMessage(jid, text, sender?)`, `ownsJid(jid)`, `isConnected()`, and optionally `setTyping()`. See [examples/telegram.js](examples/telegram.js) for a complete implementation.

## Architecture

```
Host Process                    Docker Container
┌───────────────┐              ┌──────────────────┐
│ container-     │──stdin──>   │ agent-runner.js   │
│ runner.js      │<──stdout──  │  (Claude SDK)     │
│                │              │                   │
│ ipc.js        │<──files───  │ mcp-server.js     │
│ (polls ipc/)  │              │  (MCP tools)      │
│                │───files──>  │                   │
│ group-queue.js │              │ /workspace/       │
└───────────────┘              └──────────────────┘
```

- **stdin/stdout**: ContainerInput JSON in, sentinel-delimited ContainerOutput JSON out
- **IPC files**: Atomic JSON files in `data/ipc/{group}/{messages,tasks,input}/`
- **Container workspace**: Isolated at `/workspace/group/` per group

## API

### `createConfig(overrides?)`

Create configuration. All settings have sensible defaults and can be overridden via env vars (`JSCLAW_*`).

### `runContainerAgent(group, input, onProcess?, onOutput?, config?)`

Spawn a container, run a Claude agent, stream results.

### `GroupQueue`

Per-group concurrency queue. Ensures one container per group with a global limit.

### `startIpcWatcher(deps, config?)`

Poll IPC directories for messages and task operations from containers.

### `writeIpcFile(dir, data)` / `readIpcFile(path)` / `drainIpcDir(dir)`

Low-level atomic IPC file operations.

### `validateAdditionalMounts(mounts, groupName, isMain, allowlistPath?)`

Validate volume mounts against a security allowlist.

## MCP Tools (Inside Container)

The agent has access to these tools via the jsclaw MCP server:

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to the chat immediately |
| `schedule_task` | Schedule a cron, interval, or one-shot task |
| `list_tasks` | List scheduled tasks |
| `pause_task` | Pause a scheduled task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Cancel and delete a task |

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `JSCLAW_CONTAINER_IMAGE` | `jsclaw-agent:latest` | Docker image |
| `JSCLAW_CONTAINER_RUNTIME` | `docker` | `docker`, `podman`, or `container` |
| `JSCLAW_CONTAINER_TIMEOUT` | `1800000` | Idle timeout (ms) |
| `JSCLAW_MAX_CONCURRENT` | `5` | Max concurrent containers |
| `JSCLAW_DATA_DIR` | `./data` | IPC data directory |
| `JSCLAW_SCHEDULER_POLL_INTERVAL` | `60000` | Task scheduler poll interval (ms) |
| `JSCLAW_HEARTBEAT_INTERVAL` | `1800000` | Heartbeat interval (ms, 30 min) |
| `JSCLAW_GROUPS_DIR` | `./groups` | Group workspace directory |
| `JSCLAW_LOG_LEVEL` | `info` | Log level |
| `ANTHROPIC_API_KEY` | — | Required for Claude API |

## Differences from nanoclaw

- No WhatsApp/Telegram channels — bring your own I/O
- No SQLite database — bring your own storage
- No router or message loop — build your own orchestration
- No task scheduler — implement your own scheduling
- Pure JavaScript ESM, no build step, zero host-side dependencies
- Docker by default (configurable to podman/Apple Container)

## License

MIT
