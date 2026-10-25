/**
 * Telegram channel — Bot API over fetch, long polling, zero dependencies.
 *
 * Mirrors the Nostr channel's shape: a factory returning a Channel with
 * connect/disconnect/sendMessage/ownsJid/isConnected, inbound text
 * delivered through onMessage(chatId, text) after an allowFrom check by
 * chat id or @username. `fetch` is injectable so tests run offline;
 * `handleUpdate(update)` is exposed for the same reason.
 * @module telegram
 */

/** Telegram's hard limit on a text message. */
export const TELEGRAM_MAX_TEXT = 4096;

/**
 * Split text into chunks Telegram will accept, preferring to cut at a
 * newline, then a space, then wherever the limit falls.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function chunkText(text, limit = TELEGRAM_MAX_TEXT) {
  const out = [];
  let rest = String(text ?? '');
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length || out.length === 0) out.push(rest);
  return out;
}

/**
 * Create a Telegram channel.
 *
 * @param {Object} opts
 * @param {string} opts.botToken - From @BotFather
 * @param {Array<string|number>} [opts.allowFrom] - Chat ids or @usernames allowed to talk to the bot
 * @param {boolean} [opts.open] - Answer anyone (dmPolicy 'open'); allowFrom is then ignored
 * @param {(chatId: string, text: string) => void} opts.onMessage - Inbound text
 * @param {Object} [opts.logger]
 * @param {typeof fetch} [opts.fetch] - Injectable for tests
 * @param {number} [opts.pollTimeout] - Long-poll wait in seconds (default 30)
 * @param {string} [opts.apiBase] - Default https://api.telegram.org
 * @returns {Object} Channel
 */
export function createTelegramChannel({
  botToken, allowFrom = [], open = false, onMessage, logger,
  fetch: fetchImpl = globalThis.fetch, pollTimeout = 30, apiBase = 'https://api.telegram.org',
}) {
  if (!botToken) throw new Error('telegram: botToken is required');
  if (typeof onMessage !== 'function') throw new Error('telegram: onMessage is required');
  const log = logger || console;
  const allow = new Set(allowFrom.map(String));
  const url = (method) => `${apiBase}/bot${botToken}/${method}`;

  let username = null;
  let connected = false;
  let polling = null;      // the in-flight getUpdates promise
  let abort = null;        // AbortController for the in-flight poll
  let offset = 0;

  async function call(method, body, signal) {
    const res = await fetchImpl(url(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(`telegram ${method}: ${data.description || `HTTP ${res.status}`}`);
    }
    return data.result;
  }

  function allowed(msg) {
    if (open) return true;
    const chatId = String(msg.chat.id);
    const user = msg.from?.username ? `@${msg.from.username}` : null;
    return allow.has(chatId) || (user && allow.has(user));
  }

  /** Feed one Telegram update (exposed for tests). */
  function handleUpdate(update) {
    const msg = update.message;
    if (!msg || typeof msg.text !== 'string') return;
    const chatId = String(msg.chat.id);
    if (!allowed(msg)) {
      log.info?.(`telegram: ignored message from ${msg.from?.username ? `@${msg.from.username}` : chatId} (not in allowFrom)`);
      return;
    }
    onMessage(chatId, msg.text);
  }

  async function pollLoop() {
    while (connected) {
      abort = new AbortController();
      try {
        const updates = await call('getUpdates', { offset, timeout: pollTimeout, allowed_updates: ['message'] }, abort.signal);
        for (const u of updates) {
          offset = u.update_id + 1;
          try { handleUpdate(u); } catch (err) { log.error?.(`telegram: update failed: ${err.message}`); }
        }
      } catch (err) {
        if (!connected) break;
        log.warn?.(`telegram: poll failed, retrying in 5 s: ${err.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  return {
    name: 'telegram',
    get username() { return username; },
    handleUpdate,
    async connect() {
      const me = await call('getMe');
      username = `@${me.username}`;
      connected = true;
      polling = pollLoop();
      log.info?.(`telegram: connected as ${username}`);
    },
    async disconnect() {
      connected = false;
      abort?.abort();
      await polling?.catch(() => {});
      polling = null;
    },
    isConnected() { return connected; },
    ownsJid(jid) { return /^-?\d+$/.test(String(jid)); },
    async sendMessage(jid, text) {
      for (const chunk of chunkText(text)) {
        await call('sendMessage', { chat_id: jid, text: chunk });
      }
    },
  };
}
