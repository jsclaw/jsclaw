/**
 * jsclaw + Telegram example
 *
 * A Telegram bot that runs Claude agents in Docker containers.
 * Each chat gets its own isolated container and workspace.
 *
 * Setup:
 *   1. Create a bot via @BotFather on Telegram, get the token
 *   2. Build the container image:
 *      docker build -t jsclaw-agent:latest -f node_modules/jsclaw/container/Dockerfile node_modules/jsclaw/container/
 *   3. Set environment variables:
 *      export TELEGRAM_BOT_TOKEN=your_bot_token
 *      export ANTHROPIC_API_KEY=your_api_key
 *   4. Run:
 *      node examples/telegram.js
 *
 * Dependencies:
 *   npm install jsclaw grammy
 */

import { Bot } from 'grammy';
import {
  runContainerAgent,
  GroupQueue,
  startIpcWatcher,
  createConfig,
} from 'jsclaw';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Set TELEGRAM_BOT_TOKEN environment variable');
  process.exit(1);
}

const config = createConfig();
const bot = new Bot(TOKEN);
const queue = new GroupQueue(config);

// Track sessions per chat for conversation continuity
const sessions = new Map();

/**
 * Process a message by running a container agent.
 */
async function processMessage(chatId, text, reply) {
  const folder = `tg-${chatId}`;
  const sessionId = sessions.get(chatId);

  const result = await runContainerAgent(
    { name: folder, folder },
    {
      prompt: text,
      groupFolder: folder,
      chatJid: String(chatId),
      isMain: true,
      sessionId,
    },
    null,
    async (output) => {
      if (output.result) {
        // Split long messages (Telegram limit is 4096 chars)
        const chunks = splitMessage(output.result, 4000);
        for (const chunk of chunks) {
          await reply(chunk);
        }
      }
      if (output.newSessionId) {
        sessions.set(chatId, output.newSessionId);
      }
    },
    config,
  );

  return result;
}

/**
 * Split a message into chunks at newline boundaries.
 */
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt === -1 || splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

// --- IPC watcher: handle messages sent by agents via MCP tools ---

startIpcWatcher({
  sendMessage: async (jid, text) => {
    try {
      await bot.api.sendMessage(Number(jid), text);
    } catch (err) {
      console.error(`Failed to send to ${jid}:`, err.message);
    }
  },
  onTask: async (type, data, sourceGroup, isMain) => {
    console.log(`Task IPC: ${type}`, data);
    // Implement your own task storage here
  },
  getRegisteredGroups: () => ({}),
}, config);

// --- Bot handlers ---

bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  console.log(`[${chatId}] ${ctx.from.first_name}: ${text}`);

  // Show typing indicator
  await ctx.replyWithChatAction('typing');

  // Use the queue to ensure one container per chat
  try {
    await queue.enqueueTask(String(chatId), `msg-${Date.now()}`, async () => {
      await processMessage(chatId, text, (msg) => ctx.reply(msg));
      return true;
    });
  } catch (err) {
    console.error(`Error processing message:`, err.message);
    await ctx.reply('Sorry, something went wrong. Please try again.');
  }
});

bot.command('reset', async (ctx) => {
  sessions.delete(ctx.chat.id);
  await ctx.reply('Session reset. Starting fresh.');
});

bot.command('start', async (ctx) => {
  await ctx.reply(
    'Hi! I\'m a Claude AI agent running in an isolated container.\n\n' +
    'Send me any message and I\'ll respond.\n' +
    'Use /reset to start a fresh conversation.'
  );
});

// --- Startup ---

console.log('Starting Telegram bot...');
bot.start({
  onStart: (info) => console.log(`Bot running as @${info.username}`),
});

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n${signal} received, shutting down...`);
    bot.stop();
    await queue.shutdown();
    process.exit(0);
  });
}
