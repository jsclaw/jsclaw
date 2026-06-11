/**
 * Channel registry — gateway-hosted chat surfaces, openclaw's shapes.
 *
 * Every channels.<name> block shares openclaw's universal fields:
 *   enabled    boolean (default true)
 *   dmPolicy   'allowlist' | 'open'   (default 'allowlist'; openclaw's
 *              'pairing' default is not yet supported)
 *   allowFrom  array of peer ids; dmPolicy 'open' requires it to
 *              include '*' (openclaw's double opt-in for open DMs)
 *
 * Channel-specific fields (privateKey, botToken, relays, …) pass through
 * to the factory untouched. Routing to agents lives in bindings — a
 * channel block never names an agent.
 * @module channels
 */

import { resolveBinding } from './bindings.js';
import { createNostrChannel } from './nostr.js';
import { handleCommand } from './commands.js';
import { SessionStore } from './sessions.js';

/**
 * Built-in channel factories, keyed by config block name. A factory is
 * `(block, ctx) => Channel` where ctx carries { onMessage, allowFrom,
 * open, logger, config } and the returned Channel implements
 * { connect?(), disconnect?(), sendMessage(jid, text) }.
 */
export const CHANNEL_FACTORIES = {
  telegram: async (block, ctx) => {
    if (!block.botToken) throw new Error('channels.telegram: botToken is required (use a ${ENV_VAR} reference)');
    let Bot;
    try {
      ({ Bot } = await import('grammy'));
    } catch {
      throw new Error('channels.telegram requires grammy — npm install grammy');
    }
    const bot = new Bot(block.botToken, block.botInfo ? { botInfo: block.botInfo } : undefined);
    const allow = new Set(ctx.allowFrom.map(String));
    bot.on('message:text', (tg) => {
      const chatId = String(tg.chat.id);
      const username = tg.from?.username ? `@${tg.from.username}` : null;
      if (!ctx.open && !allow.has(chatId) && !(username && allow.has(username))) {
        ctx.logger?.info?.(`telegram: ignored message from ${username || chatId} (not in allowFrom)`);
        return;
      }
      ctx.onMessage(chatId, tg.message.text);
    });
    let username = null;
    return {
      name: 'telegram',
      _bot: bot,
      get username() { return username; },
      async connect() {
        const me = await bot.api.getMe();
        username = `@${me.username}`;
        bot.start(); // long-polls until stop(); intentionally not awaited
      },
      async disconnect() { await bot.stop(); },
      async sendMessage(jid, text) { await bot.api.sendMessage(jid, text); },
    };
  },

  nostr: (block, ctx) => {
    if (!block.privateKey) throw new Error('channels.nostr: privateKey is required (use a ${ENV_VAR} reference)');
    if (block.allowed) throw new Error(`channels.nostr: 'allowed' was renamed to 'allowFrom' (openclaw alignment)`);
    if (block.agentId) throw new Error(`channels.nostr: 'agentId' was removed — route with bindings: [{ match: { channel: 'nostr' }, agentId: '...' }]`);
    return createNostrChannel({
      privateKey: block.privateKey,
      relays: block.relays || ['wss://relay.damus.io', 'wss://nos.lol'],
      allowedPubkeys: ctx.allowFrom,
      open: ctx.open,
      logger: ctx.logger,
      onMessage: ctx.onMessage,
    });
  },
};

/**
 * Validate the universal fields of a channel block.
 * @param {string} name
 * @param {Object} block
 * @returns {{ dmPolicy: string, allowFrom: Array<string|number> }}
 */
export function validateChannelBlock(name, block) {
  const dmPolicy = block.dmPolicy ?? 'allowlist';
  if (!['allowlist', 'open'].includes(dmPolicy)) {
    throw new Error(`channels.${name}.dmPolicy must be "allowlist" or "open" ("pairing" is not yet supported)`);
  }
  const allowFrom = Array.isArray(block.allowFrom) ? block.allowFrom.filter((v) => v != null) : [];
  if (dmPolicy === 'open' && !allowFrom.includes('*')) {
    throw new Error(`channels.${name}.dmPolicy="open" requires channels.${name}.allowFrom to include "*"`);
  }
  if (dmPolicy === 'allowlist' && allowFrom.length === 0) {
    throw new Error(`channels.${name}: allowFrom is required (dmPolicy "allowlist") — an open DM agent answers anyone and burns tokens`);
  }
  return { dmPolicy, allowFrom };
}

/**
 * Start every enabled channel in config.channels: construct via the
 * registry, route inbound messages through bindings to an agent, thread
 * one session per (channel, peer), reply via the channel.
 *
 * @param {Object} params
 * @param {import('./types.js').JsclawConfig} params.config
 * @param {(agentId: string, prompt: string, onOutput: Function, extra?: Object) => Promise<Object>} params.runAgent
 * @param {Record<string, Function>} [params.registry]
 * @param {Object} [params.logger]
 * @param {import('./sessions.js').SessionStore} [params.sessions] - Shared session store (persistent)
 * @returns {Promise<{ channels: Object[], stop: () => Promise<void> }>}
 */
export async function startChannels({ config, runAgent, registry = CHANNEL_FACTORIES, logger, sessions }) {
  const log = logger || config.logger;
  const started = [];
  const store = sessions || new SessionStore(config); // `${channel}:${peer}` keys

  for (const [name, block] of Object.entries(config.channels || {})) {
    if (!block || block.enabled === false) continue;
    const factory = registry[name];
    if (!factory) throw new Error(`unknown channel: ${name} (available: ${Object.keys(registry).join(', ') || 'none'})`);
    const { dmPolicy, allowFrom } = validateChannelBlock(name, block);

    let channel; // assigned before connect(); messages only flow after
    const ctx = {
      config,
      logger: log,
      open: dmPolicy === 'open',
      allowFrom: allowFrom.filter((v) => v !== '*'),
      onMessage: async (peer, text) => {
        const agentId = resolveBinding(config.bindings, { channel: name, peer: String(peer) }, 'main');
        const key = `${name}:${peer}`;

        // Slash commands are host-handled before the agent sees anything
        const command = await handleCommand(text, {
          config,
          agentId,
          reset: () => { store.reset(key); },
        }).catch(() => null);
        if (command?.reply) {
          channel.sendMessage(peer, command.reply).catch(() => {});
          return;
        }
        if (command?.prompt) text = command.prompt;

        const session = store.resolve(key, agentId);
        runAgent(agentId, text, async (output) => {
          if (output.result) await channel.sendMessage(peer, output.result);
          if (output.newSessionId) store.advance(key, output.newSessionId);
        }, {
          chatJid: String(peer),
          ...(session.sessionId && { sessionId: session.sessionId }),
          ...(session.model && { model: session.model }),
        }).catch((err) => {
          log.error(`${name} agent run failed: ${err.message}`);
          channel.sendMessage(peer, 'Sorry — something went wrong.').catch(() => {});
        });
      },
    };

    channel = await factory(block, ctx);
    await channel.connect?.();
    started.push(channel);
  }

  return {
    channels: started,
    stop: async () => {
      for (const c of started) {
        try { await c.disconnect?.(); } catch { /* shutdown is best-effort */ }
      }
    },
  };
}
