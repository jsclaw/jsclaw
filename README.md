# jsclaw

[![CI](https://github.com/jsclaw/jsclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/jsclaw/jsclaw/actions/workflows/ci.yml)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![license MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Lightweight container orchestration for Claude AI agents. Pure JavaScript ESM, zero host-side dependencies.

A JavaScript port of [nanoclaw](https://github.com/qwibitai/nanoclaw) — the core engine without the channel-specific code.

## What is jsclaw?

jsclaw provides primitives for running Claude AI agents in isolated Docker containers:

- **Gateway** — WebSocket control plane (openclaw wire shape) with token auth + built-in webchat; `npx jsclaw gateway` runs the whole host
- **Container Runner** — Spawn Docker containers, stream agent output via sentinel-delimited JSON
- **IPC System** — Filesystem-based JSON communication between host and container
- **Group Queue** — Per-group concurrency with configurable container limits
- **MCP Tools** — Send messages and schedule tasks from inside the agent
- **Task Scheduler** — Cron, interval, and one-shot tasks with zero-dep cron parsing
- **Heartbeat** — Periodic agent wake-up for autonomous operation (`HEARTBEAT.md`)
- **Identity Files** — `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`, `USER.md` loaded into the system prompt, openclaw-style
- **Channels** — Formal `Channel` interface + `ChannelManager` routing for pluggable I/O
- **Nostr** — Built-in decentralized channel: encrypted DMs (NIP-04) with zero-dep BIP340 Schnorr, verified against the official Bitcoin test vectors
- **MCP Passthrough** — Wire any of the 32,000+ MCP servers into your agents via openclaw's `mcp.servers` config shape
- **Memory** — Per-group markdown memory (`memory/preferences.md`, ...) loaded into context; agents read/write it with plain fs tools
- **Skills** — openclaw's SKILL.md format: YAML frontmatter, keyword/regex/attachment triggers, prompt injection
- **Multi-Agent Bindings** — Route messages to agents by channel/peer/account, most-specific-wins
- **Webhooks** — HTTP ingress with `{{body.field}}` templates and secret auth, plus outgoing event webhooks (openclaw-compatible shapes)
- **Config File** — Optional `jsclaw.json` with `${ENV_VAR}` expansion; overrides > env > file > defaults
- **CLI** — `npx jsclaw status|doctor|tasks|memory|skill|config|run|heartbeat`
- **Tested** — Full `node:test` suite plus Docker E2E tests against a mock agent image, zero dev-dependencies
- **Mount Security** — Validate volume mounts against allowlists

You bring your own I/O (chat, API, CLI) and storage. jsclaw handles the container orchestration.

## Install

```
npm install jsclaw
```

## Quick Start

### 0. The fast path: a full agent host in one command

```bash
docker build -t jsclaw-agent:latest -f node_modules/jsclaw/container/Dockerfile node_modules/jsclaw/container/
export ANTHROPIC_API_KEY=sk-ant-...
npx jsclaw gateway
```

Open the printed `http://127.0.0.1:18789/chat?token=...` URL and talk to your containerized agent. The gateway wires everything: orphan reaping at boot, task scheduler, heartbeat, IPC watcher, and a WebSocket API speaking openclaw's frame shape:

```javascript
// any WebSocket client
ws.send(JSON.stringify({ type: 'req', id: 1, method: 'chat.send',
  params: { groupFolder: 'main', message: 'Summarize my notes' } }));
// → { type: 'event', event: 'agent.output', payload: { ... } }  (streaming)
// → { type: 'res', id: 1, ok: true, payload: { result, newSessionId } }
```

Methods: `status`, `chat.send`, `tasks.list|pause|resume|cancel`, `heartbeat.trigger`, `memory.list|search`. Embed it yourself with `startGateway(deps, config, { port, token })`.

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

### 6½. Nostr (a decentralized agent)

Give your agent a Nostr identity and DM it from Damus, Amethyst, or any client — no bot tokens, no platform accounts, no central server. The whole stack (BIP340 Schnorr, NIP-04 encryption, bech32, relay client) is built on `node:crypto` and Node's native WebSocket: still zero dependencies.

```javascript
import { createNostrChannel, generatePrivateKey } from 'jsclaw';

const channel = createNostrChannel({
  privateKey: process.env.NOSTR_PRIVATE_KEY,   // hex or nsec
  relays: ['wss://relay.damus.io', 'wss://nos.lol'],
  allowedPubkeys: ['npub1yourkey...'],          // default-closed
  onMessage: (jid, text) => {
    // run an agent, reply with channel.sendMessage(jid, result)
  },
});

await channel.connect();
console.log('DM your agent at', channel.npub);
```

Incoming events are signature-verified and decrypted; only allowlisted pubkeys reach the agent (set `open: true` to accept anyone — at your own risk). See [examples/nostr-agent.js](examples/nostr-agent.js) for the full loop. Schnorr signing is validated against the official [BIP340 test vectors](https://github.com/bitcoin/bips/blob/master/bip-0340/test-vectors.csv) and cross-checked against `node:crypto`'s independent secp256k1 implementation.

### 7. Memory (persistent context)

Each group gets a `memory/` directory of plain Markdown — openclaw's categories (`preferences.md`, `contacts.md`, `projects.md`, `learnings.md`) plus any custom files. It rides the existing group mount, so the agent reads and writes its own memory with ordinary fs tools, and the agent runner loads it into the system prompt (budget: `JSCLAW_MEMORY_MAX_CHARS`, default 8000).

```javascript
import { initMemory, appendMemory, searchMemory, loadMemoryContext } from 'jsclaw';

initMemory('main', config);                                      // seed categories
appendMemory('main', 'preferences', 'prefers terse answers', config);
searchMemory('main', 'terse', config);                           // [{ file, line, text }]
loadMemoryContext('main', config, { maxChars: 8000 });           // system-prompt section
```

### 8. Webhooks (HTTP ingress)

openclaw-compatible shape: `POST /webhook/<path>`, `X-Webhook-Secret` header, `{{body.field}}` templates.

```javascript
import { startWebhookIngress } from 'jsclaw';

const { stop } = await startWebhookIngress({
  port: 18789,
  secret: process.env.WEBHOOK_SECRET,
  endpoints: [
    { path: '/deploy-alert', message: 'Deployment: {{body.service}} is {{body.status}}', groupFolder: 'main' },
  ],
  onMessage: async (message, endpoint) => {
    // run an agent, enqueue it, forward to a channel...
  },
}, config);
```

```bash
curl -X POST http://localhost:18789/webhook/deploy-alert \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -d '{"service": "api-v2", "status": "success"}'
```

### 9. Skills

openclaw's SKILL.md format — YAML frontmatter + Markdown instructions:

```markdown
---
name: deploy-helper
description: "Helps with deployments"
trigger: "deploy|ship|push to prod"
tools: [shell, http]
---
# Deploy Helper
When asked to deploy: run the test suite first, then tag the release.
```

Triggers: pipe-separated keywords (case-insensitive), `/regex/i`, `attachment:image`, or `*` (always-on).

```javascript
import { loadSkills, matchSkills, buildSkillContext } from 'jsclaw';

const skills = loadSkills(config);                       // from config.skillsDir
const matched = matchSkills(skills, { text: userMessage });
const skillContext = buildSkillContext(matched);          // append to the agent prompt
```

### 10. Multi-agent bindings

openclaw's routing shape — most specific match wins, deterministic:

```javascript
import { resolveBinding, resolveAgentConfig } from 'jsclaw';

const bindings = [
  { match: { channel: 'telegram', peer: 'boss-id' }, agentId: 'researcher' },
  { match: { channel: 'telegram' }, agentId: 'assistant' },
];

const agentId = resolveBinding(bindings, { channel: 'telegram', peer: 'boss-id' });
// 'researcher'

const agent = resolveAgentConfig({
  defaults: { model: 'claude-haiku-4-5-20251001' },
  list: [{ id: 'researcher', model: 'claude-opus-4-8', folder: 'research' }],
}, agentId);
```

### 11. Outgoing webhooks

```javascript
import { createWebhookEmitter } from 'jsclaw';

const emit = createWebhookEmitter([
  { event: 'agent.task.completed', url: 'https://hooks.slack.com/...', headers: { Authorization: 'Bearer ${HOOK_TOKEN}' } },
  { event: 'agent.error', url: 'https://events.pagerduty.com/...', filter: { groupFolder: 'prod' } },
]);

await emit('agent.task.completed', { taskId: 't1', groupFolder: 'main' });
```

### 11½. MCP servers (plug into the MCP ecosystem)

Declare MCP servers in `jsclaw.json` — openclaw's `mcp.servers` shape — and every agent container gets their tools:

```json
{
  "mcp": {
    "servers": {
      "github": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
      }
    }
  }
}
```

`${ENV_VAR}` references expand at load time, so secrets never live in the file. Per-group overrides via `group.mcpServers` (merged by name, group wins). The configs travel to the container over **stdin** — never argv or env flags, which leak into `ps`. The `jsclaw` server name is reserved for the built-in IPC tools and can't be shadowed.

### 12. Config file

Optional `jsclaw.json` (or `JSCLAW_CONFIG_PATH`), with `${ENV_VAR}` expansion. Precedence: explicit overrides > env vars > config file > defaults.

```json
{
  "containerImage": "my-agent:latest",
  "maxConcurrentContainers": 8,
  "mountAllowlistPath": "${HOME}/.config/jsclaw/mount-allowlist.json"
}
```

### 13. CLI

```bash
npx jsclaw status                      # config, groups, task counts
npx jsclaw doctor                      # environment health checks
npx jsclaw tasks list                  # scheduled tasks (file-based, no daemon needed)
npx jsclaw tasks pause|resume|cancel <id>
npx jsclaw memory list main            # memory files for a group
npx jsclaw memory search main "query"
npx jsclaw run main "summarize my notes"   # one-shot agent run
npx jsclaw heartbeat main --dry-run    # preview a heartbeat cycle
npx jsclaw skill list                  # installed skills
npx jsclaw skill install ./deploy.md   # install a SKILL.md
npx jsclaw skill test ./deploy.md "deploy the api"   # trigger check
npx jsclaw config list                 # effective configuration
npx jsclaw config set maxConcurrentContainers 8      # writes jsclaw.json
```

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
| `JSCLAW_MEMORY_MAX_CHARS` | `8000` | Memory budget loaded into system prompt (chars) |
| `JSCLAW_SKILLS_PATH` | `./skills` | Directory of SKILL.md files |
| `JSCLAW_CONFIG_PATH` | `./jsclaw.json` | Config file location |
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
