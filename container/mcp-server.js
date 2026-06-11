/**
 * MCP server that runs inside the container (stdio transport).
 * Exposes tools for the Claude agent: send_message, schedule_task, etc.
 *
 * Environment variables (set by host):
 *   JSCLAW_CHAT_JID     - Chat identifier for this group
 *   JSCLAW_GROUP_FOLDER  - Group folder name
 *   JSCLAW_IS_MAIN       - 'true' if this is the admin group
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const CHAT_JID = process.env.JSCLAW_CHAT_JID || '';
const GROUP_FOLDER = process.env.JSCLAW_GROUP_FOLDER || '';
const IS_MAIN = process.env.JSCLAW_IS_MAIN === 'true';
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';
const IPC_TASKS_DIR = '/workspace/ipc/tasks';

/**
 * Atomically write a JSON file to an IPC directory.
 */
function writeIpcFile(dir, data) {
  mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const tmpPath = join(dir, `.${filename}.tmp`);
  const finalPath = join(dir, filename);
  writeFileSync(tmpPath, JSON.stringify(data));
  renameSync(tmpPath, finalPath);
}

/**
 * Read current_tasks.json from the group workspace.
 */
function readCurrentTasks() {
  try {
    const raw = readFileSync('/workspace/group/current_tasks.json', 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

const TOOLS = [
  {
    name: 'send_message',
    description: 'Send a message to the chat immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send' },
        sender: { type: 'string', description: 'Optional sender name for multi-persona' },
        target_jid: { type: 'string', description: 'Target chat JID (main group only, for cross-group messaging)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'schedule_task',
    description: 'Schedule a recurring or one-shot task.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to run when the task fires' },
        schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'], description: 'Type of schedule' },
        schedule_value: { type: 'string', description: 'Cron expression, interval in ms, or ISO date' },
        context_mode: { type: 'string', enum: ['fresh', 'resume'], description: 'Whether to resume existing session or start fresh' },
        target_group_jid: { type: 'string', description: 'Target group for the task (main only)' },
      },
      required: ['prompt', 'schedule_type', 'schedule_value'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all scheduled tasks for this group.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pause_task',
    description: 'Pause a scheduled task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to pause' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'resume_task',
    description: 'Resume a paused task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to resume' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel and delete a scheduled task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to cancel' },
      },
      required: ['task_id'],
    },
  },
];

async function handleToolCall(name, args) {
  switch (name) {
    case 'send_message': {
      const { text, sender, target_jid } = args;

      // Authorization: non-main groups can't send cross-group
      if (target_jid && !IS_MAIN) {
        return { content: [{ type: 'text', text: 'Error: Only the main group can send cross-group messages.' }] };
      }

      writeIpcFile(IPC_MESSAGES_DIR, {
        text,
        sender: sender || undefined,
        targetJid: target_jid || CHAT_JID,
        sourceGroup: GROUP_FOLDER,
        timestamp: new Date().toISOString(),
      });

      return { content: [{ type: 'text', text: `Message sent: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"` }] };
    }

    case 'schedule_task': {
      const { prompt, schedule_type, schedule_value, context_mode, target_group_jid } = args;

      // Validate cron expression if applicable
      if (schedule_type === 'cron') {
        try {
          const { parseExpression } = await import('cron-parser');
          parseExpression(schedule_value);
        } catch {
          return { content: [{ type: 'text', text: `Error: Invalid cron expression: ${schedule_value}` }] };
        }
      }

      if (target_group_jid && !IS_MAIN) {
        return { content: [{ type: 'text', text: 'Error: Only the main group can schedule tasks for other groups.' }] };
      }

      writeIpcFile(IPC_TASKS_DIR, {
        type: 'schedule_task',
        data: {
          prompt,
          schedule_type,
          schedule_value,
          context_mode: context_mode || 'fresh',
          chat_jid: target_group_jid || CHAT_JID,
          group_folder: GROUP_FOLDER,
        },
        sourceGroup: GROUP_FOLDER,
        timestamp: new Date().toISOString(),
      });

      return { content: [{ type: 'text', text: `Task scheduled: ${schedule_type} "${prompt.slice(0, 100)}"` }] };
    }

    case 'list_tasks': {
      const tasks = readCurrentTasks();
      if (tasks.length === 0) {
        return { content: [{ type: 'text', text: 'No scheduled tasks.' }] };
      }
      const summary = tasks
        .map((t) => `[${t.id}] ${t.status} | ${t.schedule_type}:${t.schedule_value} | ${t.prompt?.slice(0, 60)}`)
        .join('\n');
      return { content: [{ type: 'text', text: summary }] };
    }

    case 'pause_task':
    case 'resume_task':
    case 'cancel_task': {
      const { task_id } = args;
      writeIpcFile(IPC_TASKS_DIR, {
        type: name,
        data: { task_id },
        sourceGroup: GROUP_FOLDER,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text', text: `Task ${name.replace('_task', '')}: ${task_id}` }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// --- Main ---

const server = new Server(
  { name: 'jsclaw', version: '0.0.1' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args || {});
});

const transport = new StdioServerTransport();
await server.connect(transport);
