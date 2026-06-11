/**
 * Mock agent — speaks jsclaw's full container protocol with no Claude SDK
 * and no API key. Used by test/e2e.test.js to validate the real pipeline:
 * stdin input, sentinel stdout, agent mounts, IPC files, close sentinel.
 *
 * The ContainerInput prompt selects a scenario:
 *   echo:<text>        → output result "<text>"
 *   env                → output JSCLAW_* env vars as JSON
 *   read:<file>        → output the contents of /workspace/agent/<file>
 *   ipc-message:<text> → write a message IPC file, then output ok
 *   ipc-task           → write a schedule_task IPC file, then output ok
 *   mcp-dump           → output input.mcpServers as JSON (passthrough check)
 *   model-dump         → output {model, providerEnv, envApiKey} as JSON
 *   converse           → output "ready", then echo each follow-up from
 *                        /workspace/ipc/input as its own output until _close
 *   fail               → exit 1 without emitting any output
 *   error-output       → emit a status:"error" output
 */

import { readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUTPUT_START = '---JSCLAW_OUTPUT_START---';
const OUTPUT_END = '---JSCLAW_OUTPUT_END---';
const AGENT_DIR = '/workspace/agent';
const IPC_INPUT = '/workspace/ipc/input';
const IPC_MESSAGES = '/workspace/ipc/messages';
const IPC_TASKS = '/workspace/ipc/tasks';

function writeOutput(output) {
  process.stdout.write(`\n${OUTPUT_START}\n${JSON.stringify(output)}\n${OUTPUT_END}\n`);
}

function writeIpcFile(dir, data) {
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, join(dir, name));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function drainInput() {
  let names;
  try {
    names = readdirSync(IPC_INPUT).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
  const texts = [];
  for (const name of names) {
    const path = join(IPC_INPUT, name);
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      if (data.text) texts.push(data.text);
      unlinkSync(path);
    } catch {
      // skip malformed
    }
  }
  return texts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const input = await readStdin();
  const prompt = input.prompt || '';

  if (prompt === 'fail') {
    process.exit(1);
  }

  if (prompt === 'error-output') {
    writeOutput({ status: 'error', result: null, error: 'mock failure' });
    return;
  }

  if (prompt.startsWith('echo:')) {
    writeOutput({ status: 'success', result: prompt.slice(5), newSessionId: 'mock-session-1' });
    return;
  }

  if (prompt === 'mcp-dump') {
    writeOutput({ status: 'success', result: JSON.stringify(input.mcpServers ?? null) });
    return;
  }

  if (prompt === 'model-dump') {
    writeOutput({
      status: 'success',
      result: JSON.stringify({
        model: input.model ?? null,
        providerEnv: input.providerEnv ?? null,
        // Proves credentials do NOT arrive via docker -e flags
        envApiKey: process.env.ANTHROPIC_API_KEY ?? null,
      }),
    });
    return;
  }

  if (prompt === 'env') {
    const env = {
      chatJid: process.env.JSCLAW_CHAT_JID,
      agentId: process.env.JSCLAW_AGENT_ID,
      isMain: process.env.JSCLAW_IS_MAIN,
    };
    writeOutput({ status: 'success', result: JSON.stringify(env) });
    return;
  }

  if (prompt.startsWith('read:')) {
    const file = prompt.slice(5);
    try {
      const content = readFileSync(join(AGENT_DIR, file), 'utf-8');
      writeOutput({ status: 'success', result: content });
    } catch (err) {
      writeOutput({ status: 'error', result: null, error: err.message });
    }
    return;
  }

  if (prompt.startsWith('ipc-message:')) {
    writeIpcFile(IPC_MESSAGES, {
      text: prompt.slice('ipc-message:'.length),
      targetJid: input.chatJid,
      sourceAgent: input.agentId,
      timestamp: new Date().toISOString(),
    });
    writeOutput({ status: 'success', result: 'message written' });
    return;
  }

  if (prompt === 'ipc-task') {
    writeIpcFile(IPC_TASKS, {
      type: 'schedule_task',
      data: {
        prompt: 'mock scheduled work',
        schedule_type: 'interval',
        schedule_value: '60000',
        chat_jid: input.chatJid,
        agent_folder: input.agentId,
      },
      sourceAgent: input.agentId,
      timestamp: new Date().toISOString(),
    });
    writeOutput({ status: 'success', result: 'task written' });
    return;
  }

  if (prompt === 'converse') {
    writeOutput({ status: 'success', result: 'ready', newSessionId: 'mock-session-1' });
    // Echo each follow-up as its own output until the close sentinel
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(join(IPC_INPUT, '_close'))) return;
      for (const text of drainInput()) {
        writeOutput({ status: 'success', result: `heard: ${text}`, newSessionId: 'mock-session-1' });
      }
      await sleep(100);
    }
    return;
  }

  writeOutput({ status: 'error', result: null, error: `unknown scenario: ${prompt}` });
}

main().catch((err) => {
  writeOutput({ status: 'error', result: null, error: `mock fatal: ${err.message}` });
  process.exit(1);
});
