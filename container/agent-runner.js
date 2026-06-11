/**
 * Agent runner - runs inside the container.
 * Reads ContainerInput from stdin, drives the Claude Agent SDK,
 * and writes sentinel-delimited ContainerOutput to stdout.
 *
 * Environment variables (set by host):
 *   JSCLAW_CHAT_JID       - Chat identifier
 *   JSCLAW_AGENT_ID    - Agent folder name
 *   JSCLAW_IS_MAIN         - 'true' if admin agent
 *   JSCLAW_SYSTEM_PROMPT   - Optional additional system prompt
 *   JSCLAW_ALLOWED_TOOLS   - Optional JSON array of allowed tools
 *   ANTHROPIC_API_KEY      - Required for Claude API access
 *
 * Identity files (optional, read from /workspace/agent):
 *   SOUL.md, IDENTITY.md, AGENTS.md, TOOLS.md, USER.md are concatenated
 *   in that order into the system prompt, openclaw-style. Any
 *   JSCLAW_SYSTEM_PROMPT content is appended after them.
 */

import { query } from '@anthropic-ai/claude-code';
import { readdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUTPUT_START_MARKER = '---JSCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---JSCLAW_OUTPUT_END---';

const IPC_INPUT_DIR = '/workspace/ipc/input';
const WORKSPACE_DIR = '/workspace/agent';

// Loaded into the system prompt in this order (openclaw convention):
// identity first, then instructions, then context.
const IDENTITY_FILES = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'TOOLS.md', 'USER.md'];

const DEFAULT_ALLOWED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task', 'NotebookEdit',
  'mcp__jsclaw__send_message',
  'mcp__jsclaw__schedule_task',
  'mcp__jsclaw__list_tasks',
  'mcp__jsclaw__pause_task',
  'mcp__jsclaw__resume_task',
  'mcp__jsclaw__cancel_task',
];

/**
 * Read ContainerInput JSON from stdin.
 * @returns {Promise<Object>}
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(raw);
}

/**
 * Write a ContainerOutput to stdout with sentinel markers.
 * @param {Object} output
 */
function writeOutput(output) {
  process.stdout.write(`\n${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`);
}

/**
 * Load memory/*.md from the agent workspace, truncated to a character
 * budget (JSCLAW_MEMORY_MAX_CHARS, default 8000 ≈ 2k tokens).
 * @returns {string} Memory section for the system prompt, or ''
 */
function loadMemory() {
  const maxChars = Number(process.env.JSCLAW_MEMORY_MAX_CHARS) || 8000;
  const dir = join(WORKSPACE_DIR, 'memory');
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return '';
  }

  const parts = [];
  let used = 0;
  for (const name of names) {
    let content;
    try {
      content = readFileSync(join(dir, name), 'utf-8').trim();
    } catch {
      continue;
    }
    if (!content || /^#[^\n]*$/.test(content)) continue; // empty or heading-only

    const section = `## ${name}\n${content}`;
    if (used + section.length > maxChars) {
      const remaining = maxChars - used;
      if (remaining > 100) parts.push(section.slice(0, remaining) + '\n[...memory truncated]');
      break;
    }
    parts.push(section);
    used += section.length + 2;
  }

  return parts.length > 0
    ? `# Memory\n\nYour persistent memory (read/write these files under memory/ to remember things):\n\n${parts.join('\n\n')}`
    : '';
}

/**
 * Build the system prompt: identity files, then memory, then any
 * JSCLAW_SYSTEM_PROMPT.
 * @returns {string|undefined}
 */
function buildSystemPrompt() {
  const parts = [];
  for (const name of IDENTITY_FILES) {
    try {
      const content = readFileSync(join(WORKSPACE_DIR, name), 'utf-8').trim();
      if (content) parts.push(content);
    } catch {
      // file absent — identity files are all optional
    }
  }
  const memory = loadMemory();
  if (memory) parts.push(memory);
  const extra = process.env.JSCLAW_SYSTEM_PROMPT?.trim();
  if (extra) parts.push(extra);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * Check if the close sentinel exists.
 * @returns {boolean}
 */
function shouldClose() {
  try {
    return existsSync(join(IPC_INPUT_DIR, '_close'));
  } catch {
    return false;
  }
}

/**
 * Drain pending IPC input messages.
 * @returns {string[]} Array of message texts
 */
function drainIpcInput() {
  const messages = [];
  try {
    const entries = readdirSync(IPC_INPUT_DIR).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.')
    ).sort();

    for (const name of entries) {
      const filePath = join(IPC_INPUT_DIR, name);
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        if (data.text) messages.push(data.text);
        unlinkSync(filePath);
      } catch {
        // skip malformed
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return messages;
}

/**
 * Wait for a new IPC message or close sentinel.
 * @param {number} [pollInterval=500] - ms between polls
 * @param {number} [maxWait=0] - max wait in ms (0 = forever)
 * @returns {Promise<string|null>} Message text, or null if closed
 */
async function waitForIpcMessage(pollInterval = 500, maxWait = 0) {
  const start = Date.now();
  while (true) {
    if (shouldClose()) return null;

    const messages = drainIpcInput();
    if (messages.length > 0) {
      return messages.join('\n');
    }

    if (maxWait > 0 && Date.now() - start >= maxWait) return null;
    await new Promise((r) => setTimeout(r, pollInterval));
  }
}

/**
 * Run a Claude query with the agent SDK.
 * @param {string} prompt
 * @param {Object} options
 * @returns {Promise<{ result: string|null, sessionId: string|null }>}
 */
async function runQuery(prompt, options = {}) {
  const {
    sessionId,
    systemPrompt,
    allowedTools,
    extraMcpServers,
    model,
  } = options;

  let resultText = null;
  let newSessionId = null;

  // Each passthrough server is allowed at the server level (all its tools),
  // unless the host pinned an explicit allowlist via JSCLAW_ALLOWED_TOOLS.
  const effectiveTools = allowedTools
    || [...DEFAULT_ALLOWED_TOOLS, ...Object.keys(extraMcpServers || {}).map((name) => `mcp__${name}`)];

  const queryOptions = {
    prompt,
    options: {
      cwd: WORKSPACE_DIR,
      allowedTools: effectiveTools,
      permissionMode: 'bypassPermissions',
      ...(model && { model }),
      ...(sessionId && { sessionId }),
      ...(systemPrompt && { systemPrompt }),
      mcpServers: {
        ...(extraMcpServers || {}),
        // Built-in server last: the reserved name can never be shadowed
        jsclaw: {
          command: 'node',
          args: [join(import.meta.dirname || '/app', 'mcp-server.js')],
          env: {
            JSCLAW_CHAT_JID: process.env.JSCLAW_CHAT_JID || '',
            JSCLAW_AGENT_ID: process.env.JSCLAW_AGENT_ID || '',
            JSCLAW_IS_MAIN: process.env.JSCLAW_IS_MAIN || 'false',
          },
        },
      },
    },
  };

  const conversation = query(queryOptions);

  let usage = null;
  for await (const event of conversation) {
    if (event.type === 'result') {
      resultText = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
      newSessionId = event.session_id || null;
      if (event.usage) {
        usage = {
          input_tokens: (event.usage.input_tokens || 0)
            + (event.usage.cache_read_input_tokens || 0)
            + (event.usage.cache_creation_input_tokens || 0),
          output_tokens: event.usage.output_tokens || 0,
        };
      }
    }
  }

  return { result: resultText, sessionId: newSessionId, usage };
}

// --- Main ---

async function main() {
  let input;
  try {
    input = await readStdin();
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Failed to read stdin: ${err.message}` });
    process.exit(1);
  }

  const {
    prompt,
    sessionId,
    agentId,
    isMain,
    isScheduledTask,
    mcpServers: extraMcpServers,
    providerEnv,
    model,
  } = input;

  // Provider credentials/endpoint arrive via stdin (never argv); apply
  // before any SDK query so ANTHROPIC_BASE_URL / keys take effect.
  if (providerEnv && typeof providerEnv === 'object') {
    for (const [key, value] of Object.entries(providerEnv)) {
      if (typeof value === 'string') process.env[key] = value;
    }
  }

  // Build initial prompt
  let fullPrompt = prompt;
  if (isScheduledTask) {
    fullPrompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }

  // Drain any pending IPC messages
  const pendingMessages = drainIpcInput();
  if (pendingMessages.length > 0) {
    fullPrompt += '\n\n[Pending messages]\n' + pendingMessages.join('\n');
  }

  let systemPrompt = buildSystemPrompt();
  if (input.skillsIndex) {
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${input.skillsIndex}` : input.skillsIndex;
  }
  const allowedTools = process.env.JSCLAW_ALLOWED_TOOLS
    ? JSON.parse(process.env.JSCLAW_ALLOWED_TOOLS)
    : undefined;

  let currentSessionId = sessionId || undefined;

  // Query loop: run query, wait for IPC, run again
  while (true) {
    try {
      const { result, sessionId: newSessionId, usage } = await runQuery(fullPrompt, {
        sessionId: currentSessionId,
        systemPrompt,
        allowedTools,
        extraMcpServers,
        model,
      });

      if (newSessionId) currentSessionId = newSessionId;

      writeOutput({
        status: 'success',
        result,
        newSessionId: currentSessionId,
        ...(usage && { usage }),
      });
    } catch (err) {
      writeOutput({
        status: 'error',
        result: null,
        error: err.message,
        newSessionId: currentSessionId,
      });
    }

    // Wait for next IPC message or close signal
    const nextMessage = await waitForIpcMessage();
    if (nextMessage === null) {
      // Close sentinel received or no more messages
      break;
    }

    fullPrompt = nextMessage;
  }
}

main().catch((err) => {
  writeOutput({ status: 'error', result: null, error: `Fatal: ${err.message}` });
  process.exit(1);
});
