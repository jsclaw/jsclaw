/**
 * Agent runner - runs inside the container.
 * Reads ContainerInput from stdin, drives the Claude Agent SDK,
 * and writes sentinel-delimited ContainerOutput to stdout.
 *
 * Environment variables (set by host):
 *   JSCLAW_CHAT_JID       - Chat identifier
 *   JSCLAW_GROUP_FOLDER    - Group folder name
 *   JSCLAW_IS_MAIN         - 'true' if admin group
 *   JSCLAW_SYSTEM_PROMPT   - Optional additional system prompt
 *   JSCLAW_ALLOWED_TOOLS   - Optional JSON array of allowed tools
 *   ANTHROPIC_API_KEY      - Required for Claude API access
 */

import { query } from '@anthropic-ai/claude-code';
import { readdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUTPUT_START_MARKER = '---JSCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---JSCLAW_OUTPUT_END---';

const IPC_INPUT_DIR = '/workspace/ipc/input';
const WORKSPACE_DIR = '/workspace/group';

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
  } = options;

  let resultText = null;
  let newSessionId = null;

  const queryOptions = {
    prompt,
    options: {
      cwd: WORKSPACE_DIR,
      allowedTools: allowedTools || DEFAULT_ALLOWED_TOOLS,
      permissionMode: 'bypassPermissions',
      ...(sessionId && { sessionId }),
      ...(systemPrompt && { systemPrompt }),
      mcpServers: {
        jsclaw: {
          command: 'node',
          args: [join(import.meta.dirname || '/app', 'mcp-server.js')],
          env: {
            JSCLAW_CHAT_JID: process.env.JSCLAW_CHAT_JID || '',
            JSCLAW_GROUP_FOLDER: process.env.JSCLAW_GROUP_FOLDER || '',
            JSCLAW_IS_MAIN: process.env.JSCLAW_IS_MAIN || 'false',
          },
        },
      },
    },
  };

  const conversation = query(queryOptions);

  for await (const event of conversation) {
    if (event.type === 'result') {
      resultText = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
      newSessionId = event.session_id || null;
    }
  }

  return { result: resultText, sessionId: newSessionId };
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
    groupFolder,
    isMain,
    isScheduledTask,
  } = input;

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

  const systemPrompt = process.env.JSCLAW_SYSTEM_PROMPT || undefined;
  const allowedTools = process.env.JSCLAW_ALLOWED_TOOLS
    ? JSON.parse(process.env.JSCLAW_ALLOWED_TOOLS)
    : undefined;

  let currentSessionId = sessionId || undefined;

  // Query loop: run query, wait for IPC, run again
  while (true) {
    try {
      const { result, sessionId: newSessionId } = await runQuery(fullPrompt, {
        sessionId: currentSessionId,
        systemPrompt,
        allowedTools,
      });

      if (newSessionId) currentSessionId = newSessionId;

      writeOutput({
        status: 'success',
        result,
        newSessionId: currentSessionId,
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
