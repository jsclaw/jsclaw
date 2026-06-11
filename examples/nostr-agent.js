/**
 * jsclaw + Nostr example — a decentralized Claude agent.
 *
 * Your agent gets a Nostr identity (an npub). DM it from Damus, Amethyst,
 * or any Nostr client and it answers from inside its container. No bot
 * tokens, no platform accounts, no central server — and no dependencies.
 *
 * Setup:
 *   1. Build the container image:
 *      docker build -t jsclaw-agent:latest -f node_modules/jsclaw/container/Dockerfile node_modules/jsclaw/container/
 *   2. export ANTHROPIC_API_KEY=...
 *   3. export NOSTR_PRIVATE_KEY=<hex or nsec>      # omit to generate one
 *   4. export NOSTR_ALLOWED=<your npub>            # who may talk to the agent
 *   5. node examples/nostr-agent.js
 */

import {
  createNostrChannel, generatePrivateKey, bech32Encode,
  runContainerAgent, AgentQueue, createConfig,
} from 'jsclaw';

const config = createConfig();
const queue = new AgentQueue(config);
const sessions = new Map();

const privateKey = process.env.NOSTR_PRIVATE_KEY || generatePrivateKey();
if (!process.env.NOSTR_PRIVATE_KEY) {
  console.log('Generated a new key. To keep this identity, set:');
  console.log(`  NOSTR_PRIVATE_KEY=${bech32Encode('nsec', privateKey)}`);
}

const allowed = (process.env.NOSTR_ALLOWED || '').split(',').filter(Boolean);
if (allowed.length === 0) {
  console.error('Set NOSTR_ALLOWED to your npub so the agent only answers you.');
  process.exit(1);
}

const channel = createNostrChannel({
  privateKey,
  relays: (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://nos.lol').split(','),
  allowedPubkeys: allowed,

  onMessage: (jid, text) => {
    console.log(`[${jid.slice(0, 8)}] ${text}`);
    const folder = `nostr-${jid.slice(0, 16)}`;

    queue.enqueueTask(jid, `msg-${Date.now()}`, async () => {
      const result = await runContainerAgent(
        { name: folder, folder },
        {
          prompt: text,
          agentId: folder,
          chatJid: jid,
          isMain: true,
          sessionId: sessions.get(jid),
        },
        null,
        async (output) => {
          if (output.result) await channel.sendMessage(jid, output.result);
          if (output.newSessionId) sessions.set(jid, output.newSessionId);
        },
        config,
      );
      return result.status === 'success';
    }).catch((err) => {
      console.error('agent run failed:', err.message);
      channel.sendMessage(jid, 'Sorry — something went wrong.').catch(() => {});
    });
  },
});

await channel.connect();
console.log(`\nAgent online. DM it on Nostr:\n  ${channel.npub}\n`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\nshutting down…');
    await channel.disconnect();
    await queue.shutdown();
    process.exit(0);
  });
}
