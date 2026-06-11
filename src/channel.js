/**
 * Channel contract and manager. A Channel adapts one messaging platform
 * (Telegram, Discord, an HTTP API, ...) to jsclaw; the ChannelManager
 * routes outbound messages to whichever channel owns the target JID.
 *
 * The manager's sendMessage drops straight into startIpcWatcher's
 * sendMessage dependency, so agents' send_message MCP calls reach the
 * right platform automatically.
 * @module channel
 */

import { createLogger } from './logger.js';

/**
 * @typedef {Object} Channel
 * @property {string} name - Unique channel name (e.g. 'telegram')
 * @property {() => Promise<void>} connect - Establish the connection
 * @property {() => Promise<void>} disconnect - Tear down the connection
 * @property {(jid: string, text: string, sender?: string) => Promise<void>} sendMessage - Deliver a message
 * @property {(jid: string) => boolean} ownsJid - Whether this channel handles the given JID
 * @property {() => boolean} isConnected - Current connection state
 * @property {(jid: string, isTyping: boolean) => Promise<void>} [setTyping] - Optional typing indicator
 */

export class ChannelManager {
  /** @param {{ logger?: import('./types.js').Logger }} [opts] */
  constructor(opts = {}) {
    this._log = opts.logger || createLogger();
    /** @type {Channel[]} */
    this._channels = [];
  }

  /**
   * Register a channel. Order matters: the first registered channel
   * whose ownsJid matches wins.
   * @param {Channel} channel
   */
  register(channel) {
    if (!channel?.name || typeof channel.ownsJid !== 'function') {
      throw new Error('Channel must have a name and an ownsJid(jid) function');
    }
    if (this._channels.some((c) => c.name === channel.name)) {
      throw new Error(`Channel already registered: ${channel.name}`);
    }
    this._channels.push(channel);
  }

  /** @returns {Channel[]} */
  list() {
    return [...this._channels];
  }

  /**
   * @param {string} jid
   * @returns {Channel|undefined} The channel that owns this JID
   */
  channelFor(jid) {
    return this._channels.find((c) => c.ownsJid(jid));
  }

  /** Connect all channels. A failing channel logs but doesn't block the rest. */
  async connectAll() {
    await Promise.all(
      this._channels.map(async (c) => {
        try {
          await c.connect();
          this._log.info(`Channel connected: ${c.name}`);
        } catch (err) {
          this._log.error(`Channel failed to connect: ${c.name}`, { error: err.message });
        }
      })
    );
  }

  /** Disconnect all channels. */
  async disconnectAll() {
    await Promise.all(
      this._channels.map(async (c) => {
        try {
          await c.disconnect();
        } catch (err) {
          this._log.warn(`Channel disconnect error: ${c.name}`, { error: err.message });
        }
      })
    );
  }

  /**
   * Route a message to the channel that owns the JID.
   * Bind this as startIpcWatcher's sendMessage dependency.
   * @param {string} jid
   * @param {string} text
   * @param {string} [sender]
   * @returns {Promise<boolean>} Whether a connected channel accepted it
   */
  sendMessage = async (jid, text, sender) => {
    const channel = this.channelFor(jid);
    if (!channel) {
      this._log.warn(`No channel owns JID: ${jid}`);
      return false;
    }
    if (!channel.isConnected()) {
      this._log.warn(`Channel not connected: ${channel.name}`, { jid });
      return false;
    }
    await channel.sendMessage(jid, text, sender);
    return true;
  };

  /**
   * Set a typing indicator if the owning channel supports it.
   * @param {string} jid
   * @param {boolean} isTyping
   */
  async setTyping(jid, isTyping) {
    const channel = this.channelFor(jid);
    if (channel?.setTyping && channel.isConnected()) {
      try {
        await channel.setTyping(jid, isTyping);
      } catch {
        // typing indicators are best-effort
      }
    }
  }
}
