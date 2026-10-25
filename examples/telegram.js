/**
 * jsclaw + Telegram example — a Telegram bot that runs a Claude agent.
 *
 * Zero dependencies: the channel talks to the Bot API over fetch with
 * long polling, so no webhook and no public URL are needed.
 *
 * Setup:
 *   1. Create a bot via @BotFather on Telegram, copy the token
 *   2. export TELEGRAM_BOT_TOKEN=...   ANTHROPIC_API_KEY=...
 *   3. export TELEGRAM_ALLOW=@yourusername   (or your numeric chat id)
 *   4. node examples/telegram.js, then message the bot
 *
 * For the full host (scheduler, heartbeat, web chat) put the same block
 * under "channels" in jsclaw.json and run `npx jsclaw gateway` instead.
 */

import { createTelegramChannel, runContainerAgent, AgentQueue, createConfig } from 'jsclaw';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Set TELEGRAM_BOT_TOKEN');
  process.exit(1);
}
const allowFrom = (process.env.TELEGRAM_ALLOW || '').split(',').filter(Boolean);
if (allowFrom.length === 0) {
  console.error('Set TELEGRAM_ALLOW to your @username or chat id so the bot only answers you.');
  process.exit(1);
}

const config = createConfig();
const queue = new AgentQueue(config);
const sessions = new Map();

const channel = createTelegramChannel({
  botToken: TOKEN,
  allowFrom,
  onMessage: (chatId, text) => {
    queue.enqueue(chatId, async () => {
      const result = await runContainerAgent(
        { name: 'main', folder: 'main' },
        { prompt: text, agentId: 'main', chatJid: chatId, isMain: true, sessionId: sessions.get(chatId) },
        null, null, config,
      );
      if (result.newSessionId) sessions.set(chatId, result.newSessionId);
      await channel.sendMessage(chatId, result.result || result.error || '(no reply)');
    });
  },
});

await channel.connect();
console.log(`Telegram bot ${channel.username} is listening. Ctrl-C to stop.`);
process.on('SIGINT', async () => { await channel.disconnect(); process.exit(0); });
