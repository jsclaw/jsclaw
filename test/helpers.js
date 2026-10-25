/** Shared test helpers. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConfig } from '../src/config.js';
import { acceptKey, attachWebSocket } from '../src/ws.js';

export const nullLogger = {
  debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

/**
 * A config rooted in a fresh temp directory.
 * @param {Object} [overrides]
 */
export function tempConfig(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jsclaw-test-'));
  return createConfig({
    dataDir: join(root, 'data'),
    agentsDir: join(root, 'agents'),
    skillsDir: join(root, 'skills'),
    configPath: join(root, 'jsclaw.json'), // avoid picking up a real ./jsclaw.json
    logger: nullLogger,
    ...overrides,
  });
}

/**
 * A minimal in-memory Nostr relay on jsclaw's own ws.js: stores every
 * EVENT, answers REQ with stored matches + EOSE, and streams new matches
 * to every open subscription (several per connection).
 * @param {{ requireAuth?: boolean }} [opts] - requireAuth: NIP-42 challenge
 *   on connect; EVENTs are refused with auth-required until AUTH succeeds
 */
export function startMockRelay({ requireAuth = false } = {}) {
  const stored = [];
  const authed = []; // pubkeys that completed NIP-42 AUTH
  const conns = new Set(); // { ws, subs: Map<subId, filters[]>, authed, challenge }

  function matches(filter, ev) {
    if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
    if (filter.authors && !filter.authors.includes(ev.pubkey)) return false;
    if (filter['#p']) {
      const ps = ev.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
      if (!filter['#p'].some((p) => ps.includes(p))) return false;
    }
    if (filter.since && ev.created_at < filter.since) return false;
    return true;
  }

  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    const conn = { subs: new Map(), authed: !requireAuth, challenge: Math.random().toString(36).slice(2) };
    conn.ws = attachWebSocket(socket, {
      onMessage: (text) => {
        const frame = JSON.parse(text);
        if (frame[0] === 'REQ') {
          const [, subId, ...filters] = frame;
          conn.subs.set(subId, filters);
          for (const ev of stored) {
            if (filters.some((f) => matches(f, ev))) conn.ws.send(JSON.stringify(['EVENT', subId, ev]));
          }
          conn.ws.send(JSON.stringify(['EOSE', subId]));
        } else if (frame[0] === 'EVENT') {
          const ev = frame[1];
          if (!conn.authed) {
            conn.ws.send(JSON.stringify(['OK', ev.id, false, 'auth-required: authenticate first']));
            return;
          }
          stored.push(ev);
          conn.ws.send(JSON.stringify(['OK', ev.id, true, '']));
          for (const c of conns) {
            for (const [subId, filters] of c.subs) {
              if (filters.some((f) => matches(f, ev))) c.ws.send(JSON.stringify(['EVENT', subId, ev]));
            }
          }
        } else if (frame[0] === 'AUTH') {
          const ev = frame[1];
          const ok = ev.kind === 22242 && ev.tags.some((t) => t[0] === 'challenge' && t[1] === conn.challenge);
          if (ok) { conn.authed = true; authed.push(ev.pubkey); }
          conn.ws.send(JSON.stringify(['OK', ev.id, ok, ok ? '' : 'invalid: bad challenge']));
        } else if (frame[0] === 'CLOSE') {
          conn.subs.delete(frame[1]);
        }
      },
      onClose: () => conns.delete(conn),
    }, head);
    conns.add(conn);
    if (requireAuth) conn.ws.send(JSON.stringify(['AUTH', conn.challenge]));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `ws://127.0.0.1:${server.address().port}`,
        stored,
        authed,
        stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}
